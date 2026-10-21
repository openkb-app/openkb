import { describe, it, expect } from 'vitest'
import { createApp, defineEventHandler, toWebHandler } from 'h3'
import middleware from './cross-site-writes'

const PASSED = 'reached the route'

function site() {
  const app = createApp()
  app.use(middleware)
  app.use(defineEventHandler(() => PASSED))
  return toWebHandler(app)
}

async function request(path: string, method: string, headers: Record<string, string>): Promise<Response> {
  return await site()(new Request(`http://kb.example.test${path}`, {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: '{}' }),
  }))
}

async function form(path: string, headers: Record<string, string>): Promise<Response> {
  return await site()(new Request(`http://kb.example.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: 'name=attacker&pass=secret',
  }))
}

const COOKIE = { cookie: 'SESSabc=123' }
const CROSS_SITE = { ...COOKIE, 'sec-fetch-site': 'cross-site', 'origin': 'https://evil.test' }

describe('a cookie-authed /api write', () => {
  it('is refused from another site', async () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      const res = await request('/api/node/1', method, CROSS_SITE)
      expect(res.status, method).toBe(403)
    }
  })

  it('is refused from a sibling subdomain', async () => {
    const res = await request('/api/node/1/commit', 'POST', { ...COOKIE, 'sec-fetch-site': 'same-site' })
    expect(res.status).toBe(403)
  })

  it('is refused from a foreign Origin when the browser sends no fetch metadata', async () => {
    const res = await request('/api/node/1/commit', 'POST', { ...COOKIE, origin: 'https://evil.test' })
    expect(res.status).toBe(403)
  })

  it('passes from the app\'s own pages', async () => {
    const res = await request('/api/node/1/commit', 'POST', { ...COOKIE, 'sec-fetch-site': 'same-origin', 'origin': 'http://kb.example.test' })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(PASSED)
  })

  it('leaves a request without fetch metadata or Origin to the CSRF token check', async () => {
    const res = await request('/api/node/1/commit', 'POST', COOKIE)
    expect(res.status).toBe(200)
  })
})

describe('a write without a cookie', () => {
  for (const path of ['/user/login', '/user/password']) {
    it(`${path} is refused from another site`, async () => {
      const res = await form(path, { 'sec-fetch-site': 'cross-site', 'origin': 'https://evil.test' })
      expect(res.status).toBe(403)
    })

    it(`${path} is refused from a sibling subdomain`, async () => {
      const res = await form(path, { 'sec-fetch-site': 'same-site' })
      expect(res.status).toBe(403)
    })

    it(`${path} passes from the app's own pages`, async () => {
      const res = await form(path, { 'sec-fetch-site': 'same-origin', 'origin': 'http://kb.example.test' })
      expect(res.status).toBe(200)
    })
  }
})

describe('a Bearer caller', () => {
  it('passes from anywhere when it sends no cookie', async () => {
    const res = await request('/api/agent/edit', 'POST', { 'authorization': 'Bearer t', 'sec-fetch-site': 'cross-site', 'origin': 'https://evil.test' })
    expect(res.status).toBe(200)
  })

  it('is checked like a cookie caller when it also sends a cookie', async () => {
    const res = await request('/api/node/1/commit', 'POST', { ...CROSS_SITE, authorization: 'Bearer junk' })
    expect(res.status).toBe(403)
  })
})

describe('what the middleware leaves alone', () => {
  it('a read', async () => {
    const res = await request('/api/node/1', 'GET', CROSS_SITE)
    expect(res.status).toBe(200)
  })

  it('client registration from another site', async () => {
    const res = await request('/register', 'POST', { 'sec-fetch-site': 'cross-site', 'origin': 'https://evil.test' })
    expect(res.status).toBe(200)
  })
})

describe('a write outside /api', () => {
  it('is refused from another site', async () => {
    const res = await request('/user/login', 'POST', CROSS_SITE)
    expect(res.status).toBe(403)
  })
})
