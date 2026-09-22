import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { H3Event } from 'h3'

/**
 * The MCP relay to Drupal: when it opens a session, whose listing it serves,
 * and what it does when Drupal will not answer.
 *
 * Everything is asserted through a tool it has never heard of, which is the
 * property under test — the relay must work for a tool added to Drupal after
 * this file was written. The wire is asserted too, because it is what the
 * caller pays: every HTTP request the relay makes to Drupal is recorded, so
 * "an editing call costs no MCP round trip" is a count, not a claim.
 */

/**
 * Nitro's cache, faithfully: one entry per `getKey`, and nothing shared
 * between keys. Keying is what the per-caller test turns on, so the stand-in
 * honours it rather than ignoring it.
 */
const { entries } = vi.hoisted(() => ({ entries: new Map<string, unknown>() }))
vi.mock('nitropack/runtime', () => ({
  defineCachedFunction: (
    fn: (...args: never[]) => unknown,
    opts: { getKey: (...args: never[]) => string },
  ) => async (...args: never[]) => {
    const key = await opts.getKey(...args)
    if (!entries.has(key)) entries.set(key, await fn(...args))
    return entries.get(key)
  },
}))

vi.mock('./drupal', () => ({ drupalBaseUrl: () => 'http://drupal.test' }))
vi.mock('./actor', () => ({
  forwardedAuthHeaders: (event: H3Event) => ({
    Authorization: `Bearer ${(event.context as { token: string }).token}`,
  }),
}))

/** One HTTP request the relay made to Drupal's MCP endpoint. */
interface Wire {
  method: string
  rpc?: string
  session?: string
  token?: string
}

let wire: Wire[] = []
/** What Drupal's `tools/list` answers each caller — the access filter, mocked. */
let listings: Record<string, unknown[]> = {}
/** Set to have Drupal refuse the next `tools/list`. */
let listingFails = false
/** Set to have Drupal never answer at all. */
let hangs = false
let sessionSeq = 0

function jsonRpc(id: unknown, result: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** Drupal's MCP endpoint: the handshake, the listing, the call, the DELETE. */
async function drupal(url: string | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const token = headers.get('authorization')?.replace('Bearer ', '')
  const session = headers.get('mcp-session-id') ?? undefined
  const method = init.method ?? 'GET'

  if (hangs) {
    wire.push({ method, session, token })
    return new Promise<Response>(() => {})
  }

  // The standing SSE stream the spec makes optional; Drupal answers 405.
  if (method === 'GET') {
    wire.push({ method, session, token })
    return new Response(null, { status: 405 })
  }
  if (method === 'DELETE') {
    wire.push({ method, session, token })
    return new Response(null, { status: 200 })
  }

  const message = JSON.parse(init.body as string) as { id?: unknown, method: string, params?: { name?: string } }
  wire.push({ method, rpc: message.method, session, token })

  if (message.method === 'initialize') {
    sessionSeq += 1
    return jsonRpc(message.id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'drupal', version: '1.0.0' },
    }, { 'mcp-session-id': `s-${sessionSeq}` })
  }
  if (message.method === 'notifications/initialized') {
    return new Response(null, { status: 202 })
  }
  if (message.method === 'tools/list') {
    if (listingFails) return new Response('nope', { status: 500 })
    return jsonRpc(message.id, { tools: listings[token ?? ''] ?? [] })
  }
  if (message.method === 'tools/call') {
    return jsonRpc(message.id, { content: [{ type: 'text', text: `called ${message.params?.name}` }] })
  }
  return new Response('{}', { status: 404 })
}

function event(token: string): H3Event {
  return { context: { token } } as unknown as H3Event
}

/** Just the RPC methods and the HTTP verbs that carried no RPC. */
function traffic(): string[] {
  return wire.map(call => call.rpc ?? call.method)
}

async function subject() {
  return await import('./drupal-tools')
}

const A_TOOL = { name: 'aToolInventedLater', description: 'Does a thing.', inputSchema: { type: 'object' } }
const ANOTHER_TOOL = { name: 'aToolTheOtherCallerMayUse', inputSchema: { type: 'object' } }

beforeEach(() => {
  vi.resetModules()
  entries.clear()
  wire = []
  listings = {}
  listingFails = false
  hangs = false
  sessionSeq = 0
  vi.stubGlobal('fetch', vi.fn(drupal))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('listDrupalTools', () => {
  it('opens a session, lists, and ends the session again', async () => {
    listings['agent-a'] = [A_TOOL]
    const { listDrupalTools } = await subject()

    expect(await listDrupalTools(event('agent-a'))).toEqual([A_TOOL])
    expect(traffic()).toEqual(
      expect.arrayContaining(['initialize', 'notifications/initialized', 'tools/list', 'DELETE']),
    )
    // The session Drupal handed out is the one the DELETE names.
    expect(wire.find(call => call.method === 'DELETE')?.session).toBe('s-1')
  })

  it('serves the second listing from cache, without touching Drupal', async () => {
    listings['agent-a'] = [A_TOOL]
    const { listDrupalTools } = await subject()

    await listDrupalTools(event('agent-a'))
    const afterFirst = wire.length
    expect(await listDrupalTools(event('agent-a'))).toEqual([A_TOOL])
    expect(wire.length).toBe(afterFirst)
  })

  /**
   * The listing is access-filtered, so the cache key is the caller. A shared
   * key would hand the second caller the first caller's tools — which is what
   * this asserts does not happen, and what fails the moment the key stops
   * carrying the credential.
   */
  it('caches per caller: one caller never sees another\'s tools', async () => {
    listings['agent-a'] = [A_TOOL]
    listings['agent-b'] = [ANOTHER_TOOL]
    const { listDrupalTools } = await subject()

    expect((await listDrupalTools(event('agent-a'))).map(t => t.name)).toEqual([A_TOOL.name])
    expect((await listDrupalTools(event('agent-b'))).map(t => t.name)).toEqual([ANOTHER_TOOL.name])
    // Both were asked upstream — the second was not answered out of the first's
    // entry.
    expect(traffic().filter(m => m === 'tools/list')).toHaveLength(2)
    expect(entries.size).toBe(2)
  })

  it('keys on the credential, never on the credential itself', async () => {
    listings['agent-a'] = []
    const { listDrupalTools } = await subject()
    await listDrupalTools(event('agent-a'))

    const [key] = [...entries.keys()]
    expect(key).not.toContain('agent-a')
    expect(key).toMatch(/^[\da-f]{64}$/)
  })

  it('costs nothing but itself when Drupal refuses the listing, and says why', async () => {
    listingFails = true
    const { listDrupalTools } = await subject()

    expect(await listDrupalTools(event('agent-a'))).toEqual([])
    // A tool that silently stops being advertised is unobservable; this is
    // what makes it observable.
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('not listed'),
      expect.any(Error),
    )
  })

  it('gives up on a Drupal that does not answer, instead of stalling the request', async () => {
    hangs = true
    vi.useFakeTimers()
    const { listDrupalTools } = await subject()
    try {
      const pending = listDrupalTools(event('agent-a'))
      await vi.advanceTimersByTimeAsync(3_000)
      expect(await pending).toEqual([])
    }
    finally {
      vi.useRealTimers()
    }
  })
})

describe('callDrupalTool', () => {
  it('relays a tool it has never heard of, on a session of its own', async () => {
    const { callDrupalTool } = await subject()
    const result = await callDrupalTool(event('agent-a'), 'aToolInventedLater', { q: 'x' })

    expect(result).toEqual({ content: [{ type: 'text', text: 'called aToolInventedLater' }] })
    expect(traffic()).toEqual(
      expect.arrayContaining(['initialize', 'notifications/initialized', 'tools/call', 'DELETE']),
    )
  })

  // The call is the side effect. Two calls are two calls.
  it('never answers a call out of cache', async () => {
    const { callDrupalTool } = await subject()
    await callDrupalTool(event('agent-a'), 'aToolInventedLater', {})
    await callDrupalTool(event('agent-a'), 'aToolInventedLater', {})

    expect(traffic().filter(m => m === 'tools/call')).toHaveLength(2)
  })

  it('reports an unreachable Drupal as a tool error, and says why', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    const { callDrupalTool } = await subject()
    const result = await callDrupalTool(event('agent-a'), 'x', {})

    expect(result.isError).toBe(true)
    expect((result.content as { text: string }[])[0]!.text).toContain('ECONNREFUSED')
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('not relayed'), expect.any(Error))
  })
})
