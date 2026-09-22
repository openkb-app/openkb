import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { H3Event } from 'h3'
import { forwardedAuthHeaders, resolveActor, ANONYMOUS_ACTOR } from './actor'

/**
 * The actor contract every server-side consumer (commit attribution, rate
 * limiting, the MCP tools) builds on: exactly one auth carrier is forwarded
 * (Bearer wins over cookie), identity resolves once per request through
 * `GET /openkb/agent/identity`, and `via` decides agent vs human.
 */

function makeEvent(headers: Record<string, string>): H3Event {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  )
  return {
    context: {},
    node: { req: { headers: lower } },
  } as unknown as H3Event
}

function stubIdentity(body: unknown, status = 200) {
  const impl = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response))
  vi.stubGlobal('fetch', impl)
  return impl
}

beforeEach(() => {
  vi.stubGlobal('useRuntimeConfig', () => ({ drupalBaseUrl: 'http://drupal.test/' }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('forwardedAuthHeaders', () => {
  it('forwards a Bearer token as the only carrier', () => {
    const event = makeEvent({ Authorization: 'Bearer tok-1', Cookie: 'SESS=x' })
    expect(forwardedAuthHeaders(event)).toEqual({ Authorization: 'Bearer tok-1' })
  })

  it('forwards the session cookie when no token is present', () => {
    const event = makeEvent({ Cookie: 'SESS=x' })
    expect(forwardedAuthHeaders(event)).toEqual({ Cookie: 'SESS=x' })
  })

  it('forwards nothing for an anonymous request', () => {
    expect(forwardedAuthHeaders(makeEvent({}))).toEqual({})
  })

  it('ignores a non-Bearer Authorization header', () => {
    // e.g. Basic auth meant for some intermediary — not an agent carrier.
    const event = makeEvent({ Authorization: 'Basic Zm9vOmJhcg==', Cookie: 'SESS=x' })
    expect(forwardedAuthHeaders(event)).toEqual({ Cookie: 'SESS=x' })
  })
})

describe('resolveActor', () => {
  it('resolves a token request to an agent actor, Bearer forwarded', async () => {
    const impl = stubIdentity({ uid: 5, name: 'fago', via: 'Claude' })
    const actor = await resolveActor(makeEvent({ Authorization: 'Bearer tok-1' }))
    expect(actor).toEqual({ type: 'agent', uid: 5, name: 'fago', via: 'Claude' })
    const [url, init] = impl.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toBe('http://drupal.test/openkb/agent/identity')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok-1' })
    expect((init.headers as Record<string, string>).Cookie).toBeUndefined()
  })

  it('resolves a session request to a human actor, cookie forwarded', async () => {
    const impl = stubIdentity({ uid: 3, name: 'marta', via: null })
    const actor = await resolveActor(makeEvent({ Cookie: 'SESS=x' }))
    expect(actor).toEqual({ type: 'human', uid: 3, name: 'marta', via: null })
    const [, init] = impl.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers).toMatchObject({ Cookie: 'SESS=x' })
  })

  it('short-circuits an unauthenticated request without an upstream call', async () => {
    const impl = stubIdentity({})
    await expect(resolveActor(makeEvent({}))).resolves.toBe(ANONYMOUS_ACTOR)
    expect(impl).not.toHaveBeenCalled()
  })

  it('resolves a stale cookie to anonymous', async () => {
    // A cookie Drupal does not honor as a login makes the request anonymous,
    // and the login-required identity route answers it 403.
    stubIdentity({ message: 'denied' }, 403)
    await expect(resolveActor(makeEvent({ Cookie: 'SESS=stale' }))).resolves
      .toBe(ANONYMOUS_ACTOR)
  })

  it('treats a uid-0 identity as anonymous', async () => {
    stubIdentity({ uid: 0, name: '', via: null })
    await expect(resolveActor(makeEvent({ Cookie: 'SESS=stale' }))).resolves
      .toBe(ANONYMOUS_ACTOR)
  })

  it('resolves once per request — consumers share the cached promise', async () => {
    const impl = stubIdentity({ uid: 5, name: 'fago', via: 'Claude' })
    const event = makeEvent({ Authorization: 'Bearer tok-1' })
    const [a, b] = await Promise.all([resolveActor(event), resolveActor(event)])
    expect(a).toEqual(b)
    expect(impl).toHaveBeenCalledTimes(1)
  })

  it('passes an invalid-token rejection through instead of reporting anonymous', async () => {
    stubIdentity({ message: 'bad token' }, 401)
    await expect(resolveActor(makeEvent({ Authorization: 'Bearer expired' })))
      .rejects.toMatchObject({ statusCode: 401 })
  })
})
