import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { H3Event } from 'h3'
import { makeEvent } from '../../test-support/h3'

/** The CE-API passthrough: the target comes from the router param and stays under /ce-api. */

const fetchUpstream = vi.fn()
vi.mock('../../utils/upstream', () => ({
  fetchUpstream: (...a: unknown[]) => fetchUpstream(...a),
  upstreamError: async () => new Error('upstream'),
  relaySetCookie: () => {},
}))
vi.mock('../../utils/drupal', () => ({ drupalBaseUrl: () => 'http://drupal.test' }))
vi.mock('../../utils/actor', () => ({ forwardedAuthHeaders: () => ({}) }))
vi.mock('../../utils/comark-allowed-html', () => ({ bodyAllowedHtml: async () => [] }))
vi.mock('../../utils/drupal-ce-enrich', () => ({ enrichCePage: (page: unknown) => page }))

const handler = (await import('./[...path].get')).default as unknown as
  (event: H3Event) => Promise<unknown>

/** A request for `url`, routed with the `[...path]` param `param`. */
function event(url: string, param: string): H3Event {
  return makeEvent({}, { path: url, params: { path: param } })
}

describe('/api/drupal-ce/[...path]', () => {
  beforeEach(() => {
    fetchUpstream.mockReset().mockResolvedValue({ ok: true, json: async () => ({ title: 'A page' }) })
  })

  it('forwards the router param under /ce-api', async () => {
    expect(await handler(event('/api/drupal-ce/kb/a-page?page=1', 'kb/a-page'))).toEqual({ title: 'A page' })
    expect(fetchUpstream).toHaveBeenCalledWith('http://drupal.test/ce-api/kb/a-page?page=1', expect.anything())
  })

  it.each(['../user/1', 'kb/%2e%2e/../user/1'])('answers 404 for %j', async (param) => {
    await expect(handler(event(`/api/drupal-ce/${param}`, param))).rejects.toMatchObject({ statusCode: 404 })
    expect(fetchUpstream).not.toHaveBeenCalled()
  })

  // The router hands the param over decoded; `fetch` would strip a tab and resolve `..`.
  it.each([
    ['.\t./user/1', '.%09./user/1'],
    ['kb/a#b', 'kb/a%23b'],
  ])('re-encodes %j', async (param, path) => {
    await handler(event(`/api/drupal-ce/${param}`, param))
    expect(fetchUpstream).toHaveBeenCalledWith(`http://drupal.test/ce-api/${path}`, expect.anything())
  })
})
