import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { H3Event } from 'h3'

/**
 * The one forwarding route onto Drupal (ADR 0011), and the four limits on it:
 * an allowlist of prefixes, the caller's own auth, JSON in and out so Drupal's
 * HTML pages never reach the frontend origin, and a CSRF token on every write.
 */

const fetchUpstream = vi.fn()
const upstreamError = vi.fn()
vi.mock('../../utils/upstream', () => ({
  fetchUpstream: (...a: unknown[]) => fetchUpstream(...a),
  upstreamError: (...a: unknown[]) => upstreamError(...a),
  relaySetCookie: () => {},
}))

vi.mock('../../utils/drupal', () => ({ drupalBaseUrl: () => 'http://drupal.test' }))

const readRawBody = vi.fn()
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('h3')>()
  return { ...actual, readRawBody: (...a: unknown[]) => readRawBody(...a) }
})

vi.mock('../../utils/actor', () => ({
  forwardedAuthHeaders: (event: H3Event) => {
    const cookie = event.node.req.headers.cookie
    return cookie ? { Cookie: cookie } : {}
  },
}))

const handler = (await import('./[...path]')).default as unknown as
  (event: H3Event) => Promise<unknown>

const JSON_ACCEPT = 'application/json'

function event(
  headers: Record<string, string | undefined> = { cookie: 'SESS=1', accept: JSON_ACCEPT },
  { method = 'GET', path = 'openkb/node/7/moderation' } = {},
): H3Event {
  return {
    method,
    path: `/api/drupal/${path}`,
    context: { params: { path } },
    node: { req: { method, headers } },
  } as unknown as H3Event
}

function answer(body: unknown, { status = 200, type = JSON_ACCEPT } = {}): Response {
  return {
    ok: status < 400,
    status,
    headers: { get: (name: string) => (name === 'content-type' ? type : null), getSetCookie: () => [] },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise
    throw new Error('expected a rejection')
  }
  catch (err) {
    return (err as { statusCode?: number }).statusCode ?? 0
  }
}

describe('/api/drupal/[...path]', () => {
  beforeEach(() => {
    fetchUpstream.mockReset().mockResolvedValue(answer({ nid: 7 }))
    upstreamError.mockReset().mockImplementation(async (res: Response) =>
      Object.assign(new Error('upstream'), { statusCode: res.status }),
    )
    readRawBody.mockReset().mockResolvedValue('{"space":"product"}')
  })

  it('forwards to Drupal under the caller\'s own carrier and returns its JSON', async () => {
    expect(await handler(event())).toEqual({ nid: 7 })
    expect(fetchUpstream).toHaveBeenCalledWith(
      'http://drupal.test/openkb/node/7/moderation',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Accept: JSON_ACCEPT, Cookie: 'SESS=1' }),
      }),
    )
  })

  it('refuses a caller with no session or token', async () => {
    expect(await statusOf(handler(event({ accept: JSON_ACCEPT })))).toBe(401)
    expect(fetchUpstream).not.toHaveBeenCalled()
  })

  it('refuses a caller that does not accept JSON', async () => {
    expect(await statusOf(handler(event({ cookie: 'SESS=1', accept: 'text/html' })))).toBe(406)
    expect(await statusOf(handler(event({ cookie: 'SESS=1', accept: '*/*' })))).toBe(406)
    expect(fetchUpstream).not.toHaveBeenCalled()
  })

  it('serves the allowlisted prefixes and nothing else', async () => {
    expect(await statusOf(handler(event(undefined, { path: 'user/1' })))).toBe(404)
    // A `..` segment resolves past the prefix at Drupal, so it is refused here.
    expect(await statusOf(handler(event(undefined, { path: 'openkb/../user/1' })))).toBe(404)
    expect(fetchUpstream).not.toHaveBeenCalled()
  })

  it('refuses a write that carries no CSRF token', async () => {
    const write = event(
      { cookie: 'SESS=1', accept: JSON_ACCEPT, 'content-type': JSON_ACCEPT },
      { method: 'POST', path: 'openkb/node/7/space' },
    )
    expect(await statusOf(handler(write))).toBe(403)
    expect(fetchUpstream).not.toHaveBeenCalled()
  })

  it('forwards the CSRF token a write carries', async () => {
    const write = event(
      { cookie: 'SESS=1', accept: JSON_ACCEPT, 'content-type': JSON_ACCEPT, 'x-csrf-token': 'tok' },
      { method: 'POST', path: 'openkb/node/7/space' },
    )
    await handler(write)
    expect(fetchUpstream).toHaveBeenCalledWith(
      'http://drupal.test/openkb/node/7/space',
      expect.objectContaining({
        method: 'POST',
        body: '{"space":"product"}',
        headers: expect.objectContaining({ 'X-CSRF-Token': 'tok', 'Content-Type': JSON_ACCEPT }),
      }),
    )
  })

  it('does not pass on an answer that is not JSON', async () => {
    fetchUpstream.mockResolvedValue(answer('<html>', { type: 'text/html; charset=UTF-8' }))
    expect(await statusOf(handler(event()))).toBe(502)
  })

  it('passes a JSON refusal through with its own status', async () => {
    fetchUpstream.mockResolvedValue(answer({ errors: [] }, { status: 403 }))
    expect(await statusOf(handler(event()))).toBe(403)
    expect(upstreamError).toHaveBeenCalled()
  })
})
