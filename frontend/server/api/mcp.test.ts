import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { H3Event } from 'h3'
import handler from './mcp'

/**
 * The MCP endpoint's unauthorized answers.
 *
 * A 401 here is not a dead end — it is step 1 of connect-by-URL, and the
 * `WWW-Authenticate` header is the only thing that makes it one. A client
 * handed nothing but this URL reads the header, fetches the document it names,
 * and finds its way to a login. The guard itself is asserted end to end by the
 * `mcp-connect-by-url` e2e spec; what is pinned here is that *every* refusal
 * carries the pointer, including one for a token Drupal rejected.
 */

const resolveActor = vi.fn()
const createMcpServer = vi.fn()
const transportOptions = vi.fn()

vi.mock('../utils/actor', () => ({ resolveActor: (...a: unknown[]) => resolveActor(...a) }))
vi.mock('../utils/mcp-server', () => ({ createMcpServer: (...a: unknown[]) => createMcpServer(...a) }))
vi.mock('../utils/drupal', () => ({ drupalBaseUrl: () => 'http://drupal.example.test:8080' }))
vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: class {
    constructor(options: unknown) {
      transportOptions(options)
    }

    handleRequest() {}
    close() {}
  },
}))

const HOST = 'kb.example.test:8091'
const CHALLENGE = `Bearer resource_metadata="http://${HOST}/.well-known/oauth-protected-resource/api/mcp"`

function event(headers: Record<string, string> = {}, method = 'POST'): { event: H3Event, sent: Record<string, string> } {
  const sent: Record<string, string> = {}
  const e = {
    path: '/api/mcp',
    method,
    context: {},
    node: {
      req: { url: '/api/mcp', method, headers: { host: HOST, ...headers } },
      res: {
        setHeader: (name: string, value: string) => { sent[name] = value },
        on: () => {},
      },
    },
  }
  return { event: e as unknown as H3Event, sent }
}

describe('POST /api/mcp without a usable credential', () => {
  beforeEach(() => {
    resolveActor.mockReset()
    createMcpServer.mockReset()
    transportOptions.mockReset()
  })

  it('answers 401 and says where to discover auth', async () => {
    const { event: e, sent } = event()
    await expect(handler(e)).rejects.toMatchObject({ statusCode: 401 })
    expect(sent['www-authenticate']).toBe(CHALLENGE)
    expect(resolveActor).not.toHaveBeenCalled()
  })

  it('says it for a token Drupal rejected too', async () => {
    // Set before the guards run, so a client whose stored token expired
    // re-discovers rather than being told only that it failed.
    resolveActor.mockRejectedValue(Object.assign(new Error('rejected'), { statusCode: 401 }))
    const { event: e, sent } = event({ authorization: 'Bearer stale' })
    await expect(handler(e)).rejects.toMatchObject({ statusCode: 401 })
    expect(sent['www-authenticate']).toBe(CHALLENGE)
  })

  it('refuses a human session with 403 — a browser cookie is not an MCP client', async () => {
    resolveActor.mockResolvedValue({ type: 'human', uid: 3, name: 'editor1', via: null })
    const { event: e } = event({ authorization: 'Bearer human-ish' })
    await expect(handler(e)).rejects.toMatchObject({ statusCode: 403 })
    expect(createMcpServer).not.toHaveBeenCalled()
  })

  it('lets a client registered by URL through, as it does a personal consumer', async () => {
    // `via` carrying the unverified marking is what a self-registered client
    // resolves to; the endpoint treats it as the agent it is.
    resolveActor.mockResolvedValue({ type: 'agent', uid: 3, name: 'editor1', via: 'Claude (unverified)' })
    createMcpServer.mockRejectedValue(new Error('stop here — the transport is not under test'))
    const { event: e } = event({ authorization: 'Bearer good' })
    await expect(handler(e)).rejects.toThrow('stop here')
    expect(createMcpServer).toHaveBeenCalled()
  })

  it('answers JSON rather than a stream', async () => {
    // The Drupal relay that runs the session tools reads the answer with
    // json_decode. Flipping this off would make it read nothing.
    resolveActor.mockResolvedValue({ type: 'agent', uid: 3, name: 'editor1', via: 'Claude' })
    createMcpServer.mockResolvedValue({ connect: () => {}, close: () => {} })
    const { event: e } = event({ authorization: 'Bearer good' }, 'GET')

    await handler(e)

    expect(transportOptions).toHaveBeenCalledWith(
      expect.objectContaining({ enableJsonResponse: true }),
    )
  })
})
