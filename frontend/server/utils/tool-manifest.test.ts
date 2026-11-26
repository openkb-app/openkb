import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Drupal's tool manifest as the MCP server reads it: how often Drupal is
 * asked, as whom, and what an expired entry and a failed refresh do. Every request to Drupal is
 * recorded, so "a fresh entry costs nothing" is a count.
 */

/**
 * Nitro's cache as `swr: true` behaves:
 * - a fresh entry is served;
 * - an expired one is served at once while the function runs again in the
 *   background; a failure there keeps the entry;
 * - without an entry the caller waits, and gets the error.
 *
 * With `swr: false` an expired entry waits as a missing one does.
 */
vi.mock('nitropack/runtime', () => ({
  defineCachedFunction: (
    fn: () => Promise<unknown>,
    opts: { maxAge: number, swr: boolean, getKey: () => string },
  ) => {
    const entries = new Map<string, { value: unknown, mtime: number }>()
    const pending = new Map<string, Promise<void>>()
    return async () => {
      const key = opts.getKey()
      const entry = entries.get(key)
      const expired = !entry || Date.now() - entry.mtime > opts.maxAge * 1000
      if (expired && !pending.has(key)) {
        const refresh = fn()
          .then((value) => {
            entries.set(key, { value, mtime: Date.now() })
          })
          .finally(() => pending.delete(key))
        pending.set(key, refresh)
      }
      if (entry && opts.swr) {
        pending.get(key)?.catch(() => {})
        return entry.value
      }
      await pending.get(key)
      return entries.get(key)!.value
    }
  },
}))
vi.mock('./drupal', () => ({ drupalBaseUrl: () => 'http://drupal.test' }))
vi.mock('./collab-identity', () => ({
  asCollabServer: (run: (auth: Record<string, string>) => Promise<unknown>) => run({ Authorization: 'Bearer server-token' }),
}))

/** One request made to Drupal. */
interface Wire {
  url: string
  authorization: string | null
}

/** The timer the fake timers replace, to let a background refresh finish. */
const realSetTimeout = globalThis.setTimeout

let wire: Wire[] = []
/** What Drupal answers next; the default is the manifest. */
let answer: () => Response

function manifest(names: string[]): Response {
  const tools = names.map(name => ({
    name,
    description: `Describes ${name}.`,
    inputSchema: { properties: { path: { description: 'The page path.' } } },
  }))
  return new Response(JSON.stringify({ instructions: 'Use the tools.', tools }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  wire = []
  answer = () => manifest(['get_page_for_editing', 'update_blocks'])
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    wire.push({ url, authorization: headers.get('authorization') })
    return answer()
  }))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** Lets a background refresh finish. */
function settle(): Promise<void> {
  return new Promise(resolve => realSetTimeout(resolve, 0))
}

/** The names of the tools the manifest enables, as read through the cache. */
async function load() {
  const { toolManifest } = await import('./tool-manifest')
  return async () => new Set((await toolManifest()).tools.keys())
}

describe('tool manifest', () => {
  it('reads the instructions and the tools\' texts from Drupal', async () => {
    const { toolManifest } = await import('./tool-manifest')
    const { instructions, tools } = await toolManifest()

    expect(instructions).toBe('Use the tools.')
    expect(tools.get('update_blocks')).toEqual({
      description: 'Describes update_blocks.',
      inputSchema: { properties: { path: { description: 'The page path.' } } },
    })
  })

  it('reads the enabled session tools from Drupal, as the server identity', async () => {
    const enabledSessionTools = await load()

    expect(await enabledSessionTools()).toEqual(new Set(['get_page_for_editing', 'update_blocks']))
    expect(wire).toEqual([{ url: 'http://drupal.test/openkb/agent/tool-manifest', authorization: 'Bearer server-token' }])
  })

  it('asks Drupal nothing while the entry is fresh', async () => {
    const enabledSessionTools = await load()
    await enabledSessionTools()
    vi.advanceTimersByTime(59_000)
    await enabledSessionTools()
    await enabledSessionTools()

    expect(wire).toHaveLength(1)
  })

  it('answers from an expired entry without waiting for Drupal', async () => {
    const enabledSessionTools = await load()
    await enabledSessionTools()
    vi.advanceTimersByTime(61_000)
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      wire.push({ url, authorization: null })
      return new Promise<Response>(() => {})
    }))

    expect(await enabledSessionTools()).toEqual(new Set(['get_page_for_editing', 'update_blocks']))
    expect(wire).toHaveLength(2)
  })

  it('serves the refreshed text from the read after the refresh', async () => {
    const enabledSessionTools = await load()
    await enabledSessionTools()
    vi.advanceTimersByTime(61_000)
    answer = () => manifest(['get_page_for_editing'])

    expect(await enabledSessionTools()).toEqual(new Set(['get_page_for_editing', 'update_blocks']))
    await settle()
    expect(await enabledSessionTools()).toEqual(new Set(['get_page_for_editing']))
    expect(wire).toHaveLength(2)
  })

  it.each([
    ['Drupal refuses', () => new Response('', { status: 503 })],
    ['Drupal answers something else', () => new Response('{}', { status: 200 })],
    ['Drupal answers instructions that are no text', () => new Response(JSON.stringify({ instructions: ['Use the tools.'], tools: [] }), { status: 200 })],
    ['Drupal cannot be reached', () => {
      throw new TypeError('fetch failed')
    }],
  ])('keeps serving the entry when a refresh fails because %s', async (_label, failure) => {
    const enabledSessionTools = await load()
    await enabledSessionTools()
    vi.advanceTimersByTime(61_000)
    answer = failure

    expect(await enabledSessionTools()).toEqual(new Set(['get_page_for_editing', 'update_blocks']))
    await settle()
    expect(await enabledSessionTools()).toEqual(new Set(['get_page_for_editing', 'update_blocks']))
    await settle()
    expect(wire).toHaveLength(3)
  })

  it('is an error when Drupal refuses the first read', async () => {
    answer = () => new Response('', { status: 403 })
    const enabledSessionTools = await load()

    await expect(enabledSessionTools()).rejects.toThrow('tool manifest')
  })

  it('is an error when Drupal cannot be reached for the first read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed')
    }))
    const enabledSessionTools = await load()

    await expect(enabledSessionTools()).rejects.toMatchObject({ statusCode: 503 })
  })
})
