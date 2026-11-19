import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp, createError, defineEventHandler, toWebHandler } from 'h3'
import middleware from './node-path'

const resolveNodePath = vi.fn()
vi.mock('../utils/node-path', () => ({
  resolveNodePath: (...a: unknown[]) => resolveNodePath(...a),
}))

const PAGE = 'the page behind the middleware'

/** The middleware, with the page catch-all it falls through to. */
function site() {
  const app = createApp()
  app.use(middleware)
  app.use(defineEventHandler(() => PAGE))
  return toWebHandler(app)
}

/** A request to the site, without following a redirect. */
async function request(path: string, method = 'GET'): Promise<Response> {
  return await site()(new Request(`http://kb.example.test${path}`, { method, redirect: 'manual' }))
}

describe('the /node/<nid> redirect', () => {
  beforeEach(() => {
    resolveNodePath.mockReset().mockResolvedValue('/demo-wiki/authoring-workflow')
  })

  it("sends /node/<nid> to the page's path, keeping the query, temporarily and uncached", async () => {
    const res = await request('/node/39?x=1')

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/demo-wiki/authoring-workflow?x=1')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(resolveNodePath.mock.calls[0]![1]).toBe(39)
  })

  it('sends /node/<nid>/edit to the path with ?edit', async () => {
    expect((await request('/node/39/edit')).headers.get('location')).toBe('/demo-wiki/authoring-workflow?edit')
    expect((await request('/node/39/edit?x=1')).headers.get('location')).toBe('/demo-wiki/authoring-workflow?x=1&edit')
    expect((await request('/node/39/edit?edit=1')).headers.get('location')).toBe('/demo-wiki/authoring-workflow?edit')
    expect((await request('/node/39/edit/')).headers.get('location')).toBe('/demo-wiki/authoring-workflow?edit')
  })

  it('renders a page whose path is /node/<nid> there, and sends its editor link to it', async () => {
    resolveNodePath.mockResolvedValue('/node/39')

    expect(await (await request('/node/39')).text()).toBe(PAGE)
    expect((await request('/node/39/edit')).headers.get('location')).toBe('/node/39?edit')
  })

  it('leaves a refused read of /node/<nid> to the page', async () => {
    resolveNodePath.mockRejectedValue(createError({ statusCode: 404 }))

    const res = await request('/node/39')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(PAGE)
  })

  it("answers a refused read of /node/<nid>/edit with the read's status, and no path", async () => {
    resolveNodePath.mockRejectedValue(createError({ statusCode: 403 }))

    const res = await request('/node/39/edit')
    expect(res.status).toBe(403)
    expect(res.headers.get('location')).toBeNull()
    expect(await res.text()).not.toBe(PAGE)
  })

  it('leaves every other address and method alone', async () => {
    for (const path of ['/node/39/revisions', '/node/abc', '/node/0', '/demo-wiki/node/39', '/api/node/39/path']) {
      expect(await (await request(path)).text()).toBe(PAGE)
    }
    expect(await (await request('/node/39', 'POST')).text()).toBe(PAGE)
    expect(resolveNodePath).not.toHaveBeenCalled()
  })
})
