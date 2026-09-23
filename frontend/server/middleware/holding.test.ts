import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, defineEventHandler, toWebHandler } from 'h3'

/**
 * What a browser gets while the backend is still setting itself up.
 *
 * Driven over a real h3 app, because what matters is the response: a 503 that
 * says how long to wait, and a request the backend is *not* holding reaching
 * the app behind the middleware untouched.
 */

vi.mock('../utils/drupal', () => ({ drupalBaseUrl: () => 'http://drupal.test' }))

const PAGE = 'the app behind the middleware'
const BROWSER_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'

/** Drupal's answer to the probe, with the hold header it carries or not. */
function backend(hold?: string) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', {
    status: hold ? 503 : 200,
    headers: hold ? { 'x-openkb-hold': hold } : {},
  })))
}

/** The middleware, freshly imported so its probe has not run yet. */
async function request(accept?: string, path = '/'): Promise<Response> {
  vi.resetModules()
  const middleware = (await import('./holding')).default
  const app = createApp()
  app.use(middleware)
  app.use(defineEventHandler(() => PAGE))
  return await toWebHandler(app)(new Request(`http://kb.example.test${path}`, {
    headers: accept === undefined ? {} : { accept },
  }))
}

beforeEach(() => backend())
afterEach(() => vi.unstubAllGlobals())

describe('while the backend is installing the site', () => {
  it('answers 503 with a page that says so and when to come back', async () => {
    backend('install')
    const res = await request(BROWSER_ACCEPT)
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('10')
    expect(res.headers.get('x-openkb-hold')).toBe('install')
    expect(res.headers.get('content-type')).toContain('text/html')
    const body = await res.text()
    expect(body).toContain('Setting up OpenKnowledgebase')
    expect(body).toContain('http-equiv="refresh"')
  })

  it('holds every path, so the sign-in redirect cannot win the race', async () => {
    backend('install')
    for (const path of ['/', '/access-denied', '/some/page']) {
      const res = await request(BROWSER_ACCEPT, path)
      expect(res.status, path).toBe(503)
    }
  })

  it('leaves a caller that does not take HTML to its own error handling', async () => {
    backend('install')
    for (const accept of [undefined, 'application/json', '*/*']) {
      const res = await request(accept)
      expect(res.status, String(accept)).toBe(200)
      expect(await res.text()).toBe(PAGE)
    }
  })
})

describe('while an update is pending', () => {
  it('links signing in and update.php on Drupal, which is a host of its own', async () => {
    backend('update')
    const res = await request(BROWSER_ACCEPT)
    expect(res.status).toBe(503)
    expect(res.headers.get('x-openkb-hold')).toBe('update')
    const body = await res.text()
    expect(body).toContain('<a href="http://drupal.test/user/login">')
    expect(body).toContain('<a href="http://drupal.test/update.php">update.php</a>')
  })
})

describe('when the backend is not holding', () => {
  it('serves the app', async () => {
    const res = await request(BROWSER_ACCEPT)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(PAGE)
  })

  it('serves the app when the backend cannot be reached at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connect ECONNREFUSED')
    }))
    const res = await request(BROWSER_ACCEPT)
    expect(res.status).toBe(200)
  })

  it('probes at most once per window, not once per request', async () => {
    const probe = vi.fn(async () => new Response('', { status: 200 }))
    vi.stubGlobal('fetch', probe)
    vi.resetModules()
    const middleware = (await import('./holding')).default
    const app = createApp()
    app.use(middleware)
    app.use(defineEventHandler(() => PAGE))
    const handler = toWebHandler(app)
    for (let i = 0; i < 3; i++) {
      await handler(new Request('http://kb.example.test/', { headers: { accept: BROWSER_ACCEPT } }))
    }
    expect(probe).toHaveBeenCalledTimes(1)
  })
})
