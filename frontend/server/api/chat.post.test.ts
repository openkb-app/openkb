import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { H3Event } from 'h3'
import { makeEvent } from '../test-support/h3'

/** The chat proxy maps upstream failures like every other proxy and never names the upstream. */

const UPSTREAM = 'http://drupal.internal:8080'
const rawBody = vi.fn()

vi.mock('#imports', () => ({ useRuntimeConfig: () => ({ public: {} }) }))
vi.mock('../utils/drupal', () => ({ drupalBaseUrl: () => UPSTREAM }))
vi.mock('../utils/capped-body', () => ({ readCappedBody: (...a: unknown[]) => rawBody(...a) }))

const handler = (await import('./chat.post')).default as unknown as
  (event: H3Event) => Promise<unknown>

const event = makeEvent({ 'cookie': 'SESS=1', 'x-csrf-token': 'browser-token' })

beforeEach(() => {
  rawBody.mockResolvedValue(Buffer.from('{"messages":[]}'))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('POST /api/chat', () => {
  it('maps an upstream 401 to 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('denied', { status: 401 })))
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 401 })
  })

  it('maps an upstream 403 for an anonymous caller to 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('denied', { status: 403 })))
    const anonymous = makeEvent({})
    await expect(handler(anonymous)).rejects.toMatchObject({ statusCode: 401 })
  })

  it('passes an upstream 403 for a session caller through as 403', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('denied', { status: 403 })))
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('forwards the CSRF token the browser sent', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('denied', { status: 403 }))
    vi.stubGlobal('fetch', fetch)
    await handler(event).catch(() => {})
    expect(new Headers(fetch.mock.calls[0]![1].headers).get('x-csrf-token')).toBe('browser-token')
  })

  it('forwards a Bearer token alone, without the cookie', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('denied', { status: 403 }))
    vi.stubGlobal('fetch', fetch)
    const bearer = makeEvent({ cookie: 'SESS=1', authorization: 'Bearer agent-1' })
    await handler(bearer).catch(() => {})
    const headers = new Headers(fetch.mock.calls[0]![1].headers)
    expect(headers.get('authorization')).toBe('Bearer agent-1')
    expect(headers.get('cookie')).toBeNull()
  })

  it('passes a 4xx refusal through with its own status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 400 })))
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 400 })
  })

  it.each([
    ['a broken upstream', () => Promise.resolve(new Response(`trace at ${UPSTREAM}/vercel-ai/chat`, { status: 500 }))],
    ['an unreachable upstream', () => Promise.reject(new TypeError(`connect ECONNREFUSED ${UPSTREAM}`))],
  ])('answers 503 for %s, naming neither its URL nor its body', async (_, answer) => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(answer))
    const error = await (handler(event) as Promise<unknown>).catch(e => e as Error & { statusCode: number, statusMessage: string })
    expect(error).toMatchObject({ statusCode: 503, statusMessage: 'Service temporarily unavailable' })
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain('drupal.internal')
  })
})
