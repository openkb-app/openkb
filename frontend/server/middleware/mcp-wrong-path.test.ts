import { describe, it, expect, vi } from 'vitest'
import { createApp, defineEventHandler, toWebHandler } from 'h3'
import middleware from './mcp-wrong-path'

/**
 * What a client pointed at the origin, or one segment off, gets back.
 *
 * Driven over a real h3 app rather than a fake event, because the two things
 * that matter here are only observable as a response: that nothing HTML comes
 * back, and that a request this middleware is *not* for reaches the page
 * behind it untouched.
 */

vi.mock('../utils/oauth-metadata', () => ({
  MCP_RESOURCE_PATH: '/api/mcp',
  resourceOrigin: () => 'http://kb.example.test:8091',
}))

const PAGE = 'the page behind the middleware'
const MCP_ACCEPT = 'application/json, text/event-stream'
const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'

/** The middleware, with the page catch-all it has to be able to decline to. */
function site() {
  const app = createApp()
  app.use(middleware)
  app.use(defineEventHandler(() => PAGE))
  return toWebHandler(app)
}

async function request(path: string, accept?: string, method = 'POST'): Promise<Response> {
  return await site()(new Request(`http://kb.example.test:8091${path}`, {
    method,
    headers: accept === undefined ? {} : { accept },
    ...(method === 'POST' ? { body: '{}' } : {}),
  }))
}

describe('a client one segment off, at /mcp', () => {
  it('is sent to /api/mcp with its method intact, so discovery engages there', async () => {
    const res = await request('/mcp', MCP_ACCEPT)
    expect(res.status).toBe(308)
    expect(res.headers.get('location')).toBe('/api/mcp')
    expect(res.headers.get('content-type')).toBeNull()
    expect(await res.text()).toBe('')
  })

  it('is answered the same way on the SSE leg and the teardown', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await request('/mcp', MCP_ACCEPT, method)
      expect(res.status, method).toBe(308)
      expect(res.headers.get('location'), method).toBe('/api/mcp')
    }
  })

  it('is sent on whatever it accepts, since the path already said what it is', async () => {
    // `terminateSession()` sends no `Accept` at all.
    for (const accept of [undefined, 'text/event-stream', 'text/plain']) {
      const res = await request('/mcp', accept, 'DELETE')
      expect(res.status, String(accept)).toBe(308)
      expect(res.headers.get('location'), String(accept)).toBe('/api/mcp')
    }
  })

  it('is matched the way a URL is pasted — trailing slash, any casing', async () => {
    for (const path of ['/mcp/', '/MCP', '/Mcp/']) {
      const res = await request(path, MCP_ACCEPT)
      expect(res.status, path).toBe(308)
      expect(res.headers.get('location'), path).toBe('/api/mcp')
    }
  })

  it('leaves a browser on the page, which is what a browser asked for', async () => {
    const res = await request('/mcp', BROWSER_ACCEPT, 'GET')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(PAGE)
  })
})

describe('a client pointed at the site origin', () => {
  it('is told in JSON that the endpoint is /api/mcp', async () => {
    const res = await request('/', MCP_ACCEPT)
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')

    const body = await res.json()
    expect(body.error).toBe('not_found')
    // The description is what a person reads out of their client's error, so
    // it has to name the path; the absolute URL is what they paste next.
    expect(body.error_description).toContain('/api/mcp')
    expect(body.error_description, 'offered, not asserted').toContain('If you are looking for')
    expect(body.mcp_endpoint).toBe('http://kb.example.test:8091/api/mcp')
  })

  it('never HTML — the whole point is that the client can parse the answer', async () => {
    const res = await request('/', MCP_ACCEPT)
    expect(res.headers.get('content-type')).not.toContain('text/html')
    expect(res.headers.get('location')).toBeNull()
  })

  it('does not touch a real form submit, which POSTs to its own page path', async () => {
    const res = await request('/', BROWSER_ACCEPT)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(PAGE)
  })

  it('does not touch a caller that stated no preference', async () => {
    const res = await request('/', '*/*')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(PAGE)
  })

  it('does not answer an ordinary API caller — the wire is both types together', async () => {
    for (const accept of ['application/json', 'text/event-stream', 'application/json;q=0.9']) {
      const res = await request('/', accept)
      expect(res.status, accept).toBe(200)
      expect(await res.text(), accept).toBe(PAGE)
    }
  })
})

describe('every other path', () => {
  it('reaches what serves it, including the MCP endpoint itself', async () => {
    for (const path of ['/api/mcp', '/mcp/deeper', '/product-handbook/release-checklist']) {
      const res = await request(path, MCP_ACCEPT)
      expect(res.status, path).toBe(200)
      expect(await res.text(), path).toBe(PAGE)
    }
  })
})

describe('both answers', () => {
  it('say they were chosen on Accept, so no cache serves one for the other', async () => {
    for (const path of ['/', '/mcp']) {
      const res = await request(path, MCP_ACCEPT)
      expect(res.headers.get('vary')?.toLowerCase(), path).toContain('accept')
    }
  })
})
