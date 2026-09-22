import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { H3Event } from 'h3'
import handler from './register.post'

/**
 * The registration pass-through: what it forwards, what it adds, and what it
 * refuses to decide.
 *
 * The point of these is that nothing about *policy* is asserted here, because
 * none of it lives here — a refusal comes back exactly as Drupal wrote it,
 * status included. What is asserted is the one thing the relay is responsible
 * for: the credential that makes the Drupal bridge internal.
 */

const DRUPAL = 'http://drupal.example.test:8080'
const fetchUpstream = vi.fn()
const rawBody = vi.fn()
const configured = vi.fn()
const forgetCollabToken = vi.fn()

vi.mock('../utils/drupal', () => ({ drupalBaseUrl: () => DRUPAL }))
vi.mock('../utils/collab-identity', () => ({
  collabIdentityConfigured: () => configured(),
  collabAuthHeaders: async () => ({ Authorization: 'Bearer the-server-token' }),
  forgetCollabToken: () => forgetCollabToken(),
}))
vi.mock('../utils/upstream', () => ({ fetchUpstream: (...a: unknown[]) => fetchUpstream(...a) }))
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('h3')>()
  return { ...actual, readRawBody: (...a: unknown[]) => rawBody(...a) }
})

const BODY = '{"client_name":"Claude","redirect_uris":["https://claude.ai/cb"]}'

function event(ip = '203.0.113.9'): H3Event & { status?: number, headers: Record<string, string> } {
  const headers: Record<string, string> = {}
  const e = {
    path: '/register',
    method: 'POST',
    context: {},
    node: {
      req: { url: '/register', method: 'POST', headers: { 'x-forwarded-for': ip }, socket: {} },
      res: {
        setHeader: (name: string, value: string) => { headers[name] = value },
        statusCode: 200,
      },
    },
    headers,
  }
  return e as unknown as H3Event & { status?: number, headers: Record<string, string> }
}

function upstream(status: number, body: unknown): Response {
  return { status, json: async () => body } as unknown as Response
}

function upstreamHtml(status: number): Response {
  return {
    status,
    json: async () => { throw new SyntaxError('Unexpected token \'<\'') },
  } as unknown as Response
}

function callRegister(e: H3Event) {
  return handler(e)
}

describe('POST /register', () => {
  beforeEach(() => {
    fetchUpstream.mockReset()
    rawBody.mockReset().mockResolvedValue(BODY)
    forgetCollabToken.mockReset()
    configured.mockReset().mockReturnValue(true)
  })

  it('forwards the body verbatim with the server credential attached', async () => {
    fetchUpstream.mockResolvedValue(upstream(201, { client_id: 'abc', scope: 'agent:read' }))
    const e = event()

    await expect(callRegister(e)).resolves.toEqual({ client_id: 'abc', scope: 'agent:read' })

    const [url, init] = fetchUpstream.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${DRUPAL}/openkb/agent/register`)
    expect(init.method).toBe('POST')
    // Byte for byte: the relay does not parse, normalise or re-serialise the
    // client's metadata, so what policy sees is what the client sent.
    expect(init.body).toBe(BODY)
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer the-server-token')
    expect(e.node.res.statusCode).toBe(201)
  })

  it('describes nothing about the registrant to Drupal', async () => {
    fetchUpstream.mockResolvedValue(upstream(201, { client_id: 'abc' }))
    await callRegister(event('198.51.100.4'))
    const [, init] = fetchUpstream.mock.calls[0] as [string, RequestInit]
    expect(Object.keys(init.headers as Record<string, string>).sort())
      .toEqual(['Accept', 'Authorization', 'Content-Type'])
  })

  it.each([
    { status: 400, body: { error: 'invalid_redirect_uri', error_description: 'Not an acceptable redirect URI: ftp://x/cb.' } },
    { status: 400, body: { error: 'invalid_client_metadata', error_description: 'Not available to a self-registered client: agent:write. This site grants: agent:read.' } },
    { status: 403, body: { error: 'invalid_request', error_description: 'Client registration is not available here.' } },
  ])('relays a $status $body.error refusal unchanged', async ({ status, body }) => {
    fetchUpstream.mockResolvedValue(upstream(status, body))
    const e = event()
    await expect(callRegister(e)).resolves.toEqual(body)
    expect(e.node.res.statusCode).toBe(status)
  })

  it('issues a fresh token once when Drupal refuses the held one', async () => {
    // The consumer re-provisioned or the keys rotated: the token in hand is
    // no longer honoured and one retry is the whole answer.
    fetchUpstream
      .mockResolvedValueOnce(upstream(401, { error: 'invalid_token' }))
      .mockResolvedValueOnce(upstream(201, { client_id: 'abc' }))
    const e = event()

    await expect(callRegister(e)).resolves.toEqual({ client_id: 'abc' })
    expect(forgetCollabToken).toHaveBeenCalledOnce()
    expect(fetchUpstream).toHaveBeenCalledTimes(2)
    expect(e.node.res.statusCode).toBe(201)
  })

  it('answers in OAuth\'s shape when Drupal has no registration bridge', async () => {
    // A site that leaves openkb_agent_registration uninstalled: the bridge
    // route does not exist and Drupal serves its 404 page. The relay states
    // that in the shape a client can read, at the status the site gave.
    fetchUpstream.mockResolvedValue(upstreamHtml(404))
    const e = event()
    await expect(callRegister(e)).resolves.toEqual({
      error: 'invalid_request',
      error_description: 'Client registration is not available on this site.',
    })
    expect(e.node.res.statusCode).toBe(404)
  })

  it('refuses instead of registering when no credential is configured', async () => {
    configured.mockReturnValue(false)
    const e = event()
    const result = await callRegister(e) as { error: string }
    expect(result.error).toBe('temporarily_unavailable')
    expect(e.node.res.statusCode).toBe(503)
    // An unconfigured server never reaches Drupal, so it cannot accidentally
    // register anything under a blank credential.
    expect(fetchUpstream).not.toHaveBeenCalled()
  })
})
