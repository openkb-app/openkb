import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { H3Event } from 'h3'
import { makeEvent } from '../../test-support/h3'

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

const handler = (await import('./[...path]')).default as unknown as
  (event: H3Event) => Promise<unknown>

const JSON_ACCEPT = 'application/json'

/** A forwarded request for the Drupal path `path`. */
function event(
  headers: Record<string, string | undefined> = { cookie: 'SESS=1', accept: JSON_ACCEPT },
  { method = 'GET', path = 'openkb/node/7/moderation' } = {},
): H3Event {
  return makeEvent(headers, { method, path: `/api/drupal/${path}`, params: { path } })
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

  it('passes a bodiless 204 on, as a JSON:API delete answers', async () => {
    fetchUpstream.mockResolvedValue(answer(undefined, { status: 204, type: '' }))
    readRawBody.mockResolvedValue(undefined)
    const deleted = event(
      { 'cookie': 'SESS=1', 'accept': 'application/vnd.api+json', 'x-csrf-token': 't' },
      { method: 'DELETE', path: 'jsonapi/openkb_invite/openkb_invite/1b4e28ba-2fa1-11d2-883f-0016d3cca427' },
    )
    expect(await handler(deleted)).toBeNull()
    expect(fetchUpstream).toHaveBeenCalledWith(
      'http://drupal.test/jsonapi/openkb_invite/openkb_invite/1b4e28ba-2fa1-11d2-883f-0016d3cca427',
      expect.objectContaining({ method: 'DELETE' }),
    )
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
    expect(await statusOf(handler(event(undefined, { path: 'jsonapi/user/user' })))).toBe(404)
    // A `..` segment resolves past the prefix at Drupal, so it is refused here.
    expect(await statusOf(handler(event(undefined, { path: 'openkb/../user/1' })))).toBe(404)
    expect(await statusOf(handler(event(undefined, { path: 'openkb/%2e%2e/user/1' })))).toBe(404)
    expect(fetchUpstream).not.toHaveBeenCalled()
  })

  it('forwards the invite collection and single invites, not their relationships', async () => {
    await handler(event(undefined, { path: 'jsonapi/openkb_invite/openkb_invite' }))
    expect(fetchUpstream).toHaveBeenCalledWith('http://drupal.test/jsonapi/openkb_invite/openkb_invite', expect.anything())
    const uuid = '0b9e3f0e-6c1a-4f7e-9d43-2a1b5c6d7e8f'
    await handler(event(undefined, { path: `jsonapi/openkb_invite/openkb_invite/${uuid}` }))
    expect(fetchUpstream).toHaveBeenCalledTimes(2)
    for (const path of [`${uuid}/space`, `${uuid}/relationships/invitee`]) {
      expect(await statusOf(handler(event(undefined, { path: `jsonapi/openkb_invite/openkb_invite/${path}` })))).toBe(404)
    }
    expect(fetchUpstream).toHaveBeenCalledTimes(2)
  })

  it('re-encodes the decoded router param, so `fetch` resolves no `..`', async () => {
    await handler(event(undefined, { path: 'openkb/.\t./.\t./user/1' }))
    expect(fetchUpstream).toHaveBeenCalledWith('http://drupal.test/openkb/.%09./.%09./user/1', expect.anything())
  })

  it('forwards a Bearer write without a CSRF token, and without the cookie', async () => {
    const write = event(
      { cookie: 'SESS=1', authorization: 'Bearer agent-1', accept: JSON_ACCEPT, 'content-type': JSON_ACCEPT },
      { method: 'POST', path: 'openkb/node/7/space' },
    )
    await handler(write)
    const { headers } = fetchUpstream.mock.calls[0]![1] as { headers: Record<string, string> }
    expect(headers.Authorization).toBe('Bearer agent-1')
    expect(headers.Cookie).toBeUndefined()
    expect(headers['X-CSRF-Token']).toBeUndefined()
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
