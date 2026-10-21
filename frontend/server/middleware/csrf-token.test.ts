import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, defineEventHandler, toWebHandler } from 'h3'

const sessionToken = vi.fn<(cookie: string) => Promise<string | null>>()
vi.mock('../utils/csrf', () => ({
  isSessionCsrfToken: async (cookie: string, token: string | undefined) =>
    !!token && token === await sessionToken(cookie),
}))

const middleware = (await import('./csrf-token')).default

const PASSED = 'reached the route'

async function request(path: string, method: string, headers: Record<string, string>): Promise<Response> {
  const app = createApp()
  app.use(middleware)
  app.use(defineEventHandler(() => PASSED))
  return await toWebHandler(app)(new Request(`http://kb.example.test${path}`, {
    method,
    headers,
    ...(method === 'GET' ? {} : { body: '{}' }),
  }))
}

const COOKIE = { cookie: 'SESSabc=123' }

beforeEach(() => {
  sessionToken.mockReset()
  sessionToken.mockResolvedValue('session-token')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a cookie-authenticated /api write', () => {
  it('passes with the session\'s token', async () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      const res = await request('/api/node/1', method, { ...COOKIE, 'x-csrf-token': 'session-token' })
      expect(res.status, method).toBe(200)
    }
    expect(sessionToken).toHaveBeenCalledWith('SESSabc=123')
  })

  it('is refused without a token, also without fetch metadata or Origin', async () => {
    const res = await request('/api/node/1/commit', 'POST', COOKIE)
    expect(res.status).toBe(403)
  })

  it('is refused with another token', async () => {
    const res = await request('/api/node/1/commit', 'POST', { ...COOKIE, 'x-csrf-token': 'forged-token' })
    expect(res.status).toBe(403)
  })

  it('is refused when Drupal gives no token for the session', async () => {
    sessionToken.mockResolvedValue(null)
    const res = await request('/api/node/1/commit', 'POST', { ...COOKIE, 'x-csrf-token': 'session-token' })
    expect(res.status).toBe(403)
  })
})

describe('needs no token', () => {
  it('for a read', async () => {
    const res = await request('/api/node/1', 'GET', COOKIE)
    expect(res.status).toBe(200)
  })

  it('for a request without a cookie', async () => {
    const res = await request('/api/comark/indexable', 'POST', {})
    expect(res.status).toBe(200)
  })

  it('for a Bearer caller, whose cookie is not forwarded', async () => {
    const res = await request('/api/agent/edit', 'POST', { ...COOKIE, authorization: 'Bearer agent-token' })
    expect(res.status).toBe(200)
  })

  it('for a write outside /api, where Drupal checks its own form token', async () => {
    const res = await request('/user/login', 'POST', COOKIE)
    expect(res.status).toBe(200)
    expect(sessionToken).not.toHaveBeenCalled()
  })
})

describe('a write whose token Drupal checks', () => {
  it.each([
    ['POST', '/api/chat'],
    ['POST', '/api/kb'],
    ['POST', '/api/node/1/space'],
    ['POST', '/api/node/1/validate?dry=1'],
    ['POST', '/api/spaces'],
    ['PATCH', '/api/spaces/team'],
    ['PATCH', '/api/spaces/team/outline'],
  ])('%s %s passes without a token', async (method, path) => {
    const res = await request(path, method, COOKIE)
    expect(res.status).toBe(200)
    expect(sessionToken).not.toHaveBeenCalled()
  })

  it.each([
    ['DELETE', '/api/node/1'],
    ['POST', '/api/node/1/publish'],
    ['POST', '/api/drupal/openkb/agent/register'],
    ['POST', '/api/chat/other'],
    ['PATCH', '/api/kb'],
  ])('%s %s still needs one', async (method, path) => {
    const res = await request(path, method, COOKIE)
    expect(res.status).toBe(403)
  })
})
