import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApp, createError, createRouter, toWebHandler } from 'h3'
import handler from './path.get'

const resolveNodePath = vi.fn()
vi.mock('../../../utils/node-path', () => ({
  resolveNodePath: (...a: unknown[]) => resolveNodePath(...a),
}))

/** A GET of the endpoint for a node id segment. */
async function request(id: string): Promise<Response> {
  const app = createApp()
  app.use(createRouter().get('/api/node/:id/path', handler))
  return await toWebHandler(app)(new Request(`http://kb.example.test/api/node/${id}/path`))
}

describe('GET /api/node/<nid>/path', () => {
  beforeEach(() => {
    resolveNodePath.mockReset().mockResolvedValue('/demo-wiki/authoring-workflow')
  })

  it("answers the page's path, uncached", async () => {
    const res = await request('39')

    expect(await res.json()).toEqual({ path: '/demo-wiki/authoring-workflow' })
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(resolveNodePath.mock.calls[0]![1]).toBe(39)
  })

  it('takes digits only as the node id', async () => {
    for (const id of ['0x10', '1e3', '0', 'abc']) {
      expect((await request(id)).status).toBe(400)
    }
    expect(resolveNodePath).not.toHaveBeenCalled()
  })

  it("answers with Drupal's refusal", async () => {
    resolveNodePath.mockRejectedValue(createError({ statusCode: 403 }))

    expect((await request('39')).status).toBe(403)
  })
})
