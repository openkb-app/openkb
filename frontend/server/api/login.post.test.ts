import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { H3Event } from 'h3'
import handler from './login.post'

/**
 * The login route's whole job is telling two failure classes apart:
 * "your password is wrong" (401) vs "the backend is down" (503). Getting that
 * mapping wrong makes users retry a correct password against a dead service.
 */

const readBody = vi.fn()
const setResponseHeader = vi.fn()

vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('h3')>()
  return { ...actual, readBody: (...a: unknown[]) => readBody(...a), setResponseHeader: (...a: unknown[]) => setResponseHeader(...a) }
})

const event = {} as H3Event

function response(status: number, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : '{}', { status, headers })
}

beforeEach(() => {
  vi.stubGlobal('useRuntimeConfig', () => ({ drupalBaseUrl: 'http://drupal.test' }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  readBody.mockResolvedValue({ name: 'admin', pass: 'lupus123' })
  setResponseHeader.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function callLogin() {
  return handler(event)
}

describe('POST /api/login', () => {
  it('returns 400 when credentials are missing', async () => {
    readBody.mockResolvedValue({ name: 'admin' })
    await expect(callLogin()).rejects.toMatchObject({ statusCode: 400 })
  })

  it('relays the session cookie on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, { 'set-cookie': 'SESSabc=1; Path=/' })))
    await expect(callLogin()).resolves.toEqual({ ok: true })
    expect(setResponseHeader).toHaveBeenCalledWith(event, 'set-cookie', 'SESSabc=1; Path=/')
  })

  it('maps a Drupal credential rejection to 401', async () => {
    // Drupal's JSON login endpoint answers 400 for a bad username/password.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(400)))
    await expect(callLogin()).rejects.toMatchObject({
      statusCode: 401,
      statusMessage: 'Invalid username or password',
    })
  })

  it('maps a 403 from Drupal (e.g. flood control) to 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(403)))
    await expect(callLogin()).rejects.toMatchObject({ statusCode: 401 })
  })

  it('maps a broken backend (5xx) to 503, never to a credential error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(500)))
    await expect(callLogin()).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: 'Service temporarily unavailable',
    })
  })

  it('maps an unreachable backend (transport failure) to 503', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    await expect(callLogin()).rejects.toMatchObject({ statusCode: 503 })
  })

  it('never leaks the upstream URL or body in the client-facing message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('Fatal error: Drupal bootstrap at /app/web/index.php', { status: 500 }),
    ))
    await expect(callLogin()).rejects.toSatisfy((e: { statusMessage: string }) =>
      !/drupal\.test|index\.php|Fatal/.test(e.statusMessage))
  })
})
