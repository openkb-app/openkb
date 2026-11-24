import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { H3Event } from 'h3'
import { createError } from 'h3'
import { serveMcp as handler } from './mcp-endpoint'

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

vi.mock('./actor', () => ({ resolveActor: (...a: unknown[]) => resolveActor(...a) }))
vi.mock('./mcp-server', () => ({ createMcpServer: (...a: unknown[]) => createMcpServer(...a) }))
vi.mock('./drupal', () => ({ drupalBaseUrl: () => 'http://drupal.example.test:8080' }))
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
const CHALLENGE = `Bearer resource_metadata="http://${HOST}/.well-known/oauth-protected-resource/mcp"`

interface Sent {
  headers: Record<string, string>
  status?: number
  body?: string
}

/** Builds a request to `/mcp` with the given headers and records what the handler sends back. */
function fakeMcpRequest(headers: Record<string, string> = {}, method = 'POST'): { event: H3Event, sent: Sent } {
  const sent: Sent = { headers: {} }
  const res = {
    setHeader: (name: string, value: string) => { sent.headers[name] = value },
    on: () => {},
    end: (body: string) => { sent.body = body },
    set statusCode(code: number) { sent.status = code },
    get statusCode() { return sent.status ?? 200 },
  }
  const e = {
    path: '/mcp',
    method,
    context: {},
    node: {
      req: { url: '/mcp', method, headers: { host: HOST, ...headers } },
      res,
    },
  }
  return { event: e as unknown as H3Event, sent }
}

describe('POST /mcp without a usable credential', () => {
  beforeEach(() => {
    resolveActor.mockReset()
    createMcpServer.mockReset()
    transportOptions.mockReset()
  })

  it('answers 401 and says where to discover auth', async () => {
    const { event: e, sent } = fakeMcpRequest()
    await handler(e)
    expect(sent.status).toBe(401)
    expect(sent.headers['www-authenticate']).toBe(CHALLENGE)
    expect(resolveActor).not.toHaveBeenCalled()
  })

  it('sends the refusal in JSON itself, whatever the caller accepts', async () => {
    const { event: e, sent } = fakeMcpRequest({ accept: '*/*' })
    await handler(e)
    expect(sent.headers['content-type']).toContain('application/json')
    expect(JSON.parse(sent.body!)).toMatchObject({ statusCode: 401, statusMessage: 'Bearer token required' })
  })

  it('says it for a token Drupal rejected too', async () => {
    // Set before the guards run, so a client whose stored token expired
    // re-discovers rather than being told only that it failed.
    resolveActor.mockRejectedValue(Object.assign(new Error('rejected'), { statusCode: 401 }))
    const { event: e, sent } = fakeMcpRequest({ authorization: 'Bearer stale' })
    await handler(e)
    expect(sent.status).toBe(401)
    expect(sent.headers['www-authenticate']).toBe(CHALLENGE)
  })

  it('answers 503 in JSON and logs it', async () => {
    const failure = createError({ statusCode: 503, statusMessage: 'Drupal unreachable' })
    resolveActor.mockRejectedValue(failure)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { event: e, sent } = fakeMcpRequest({ authorization: 'Bearer good', accept: '*/*' })
    await handler(e)
    expect(sent.status).toBe(503)
    expect(sent.headers['content-type']).toContain('application/json')
    expect(JSON.parse(sent.body!)).toMatchObject({ statusCode: 503, statusMessage: 'Drupal unreachable' })
    expect(consoleError).toHaveBeenCalledWith('[mcp] guard failed', failure)
    consoleError.mockRestore()
  })

  it('refuses a human session with 403 — a browser cookie is not an MCP client', async () => {
    resolveActor.mockResolvedValue({ type: 'human', uid: 3, name: 'editor1', via: null })
    const { event: e, sent } = fakeMcpRequest({ authorization: 'Bearer human-ish' })
    await handler(e)
    expect(sent.status).toBe(403)
    expect(createMcpServer).not.toHaveBeenCalled()
  })

  it('lets a client registered by URL through, as it does a personal consumer', async () => {
    // `via` carrying the unverified marking is what a self-registered client
    // resolves to; the endpoint treats it as the agent it is.
    resolveActor.mockResolvedValue({ type: 'agent', uid: 3, name: 'editor1', via: 'Claude (unverified)' })
    createMcpServer.mockRejectedValue(new Error('stop here — the transport is not under test'))
    const { event: e } = fakeMcpRequest({ authorization: 'Bearer good' })
    await expect(handler(e)).rejects.toThrow('stop here')
    expect(createMcpServer).toHaveBeenCalled()
  })

  it('answers JSON rather than a stream', async () => {
    // The Drupal relay that runs the session tools reads the answer with
    // json_decode. Flipping this off would make it read nothing.
    resolveActor.mockResolvedValue({ type: 'agent', uid: 3, name: 'editor1', via: 'Claude' })
    createMcpServer.mockResolvedValue({ connect: () => {}, close: () => {} })
    const { event: e } = fakeMcpRequest({ authorization: 'Bearer good' }, 'GET')

    await handler(e)

    expect(transportOptions).toHaveBeenCalledWith(
      expect.objectContaining({ enableJsonResponse: true }),
    )
  })
})
