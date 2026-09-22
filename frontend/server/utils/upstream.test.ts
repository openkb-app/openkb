import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mapUpstreamStatus, fetchUpstream, upstreamError } from './upstream'

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('mapUpstreamStatus', () => {
  it('collapses every upstream 5xx to 503', () => {
    expect(mapUpstreamStatus(500)).toBe(503)
    expect(mapUpstreamStatus(502)).toBe(503)
    expect(mapUpstreamStatus(504)).toBe(503)
  })

  it('passes actionable 4xx through untouched', () => {
    expect(mapUpstreamStatus(404)).toBe(404)
    expect(mapUpstreamStatus(403)).toBe(403)
  })
})

describe('fetchUpstream', () => {
  it('turns a transport failure into a 503 instead of an unhandled rejection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    await expect(fetchUpstream('http://drupal.test/x')).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: 'Service temporarily unavailable',
    })
  })

  it('returns non-ok responses for the caller to classify', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })))
    await expect(fetchUpstream('http://drupal.test/x')).resolves.toMatchObject({ status: 404 })
  })
})

describe('upstreamError', () => {
  it('keeps the upstream body and URL out of the client-facing message', async () => {
    const err = await upstreamError(
      new Response('SQLSTATE[HY000] at /app/web/core/lib/Database.php', { status: 500 }),
      'GET /jsonapi/node/kb_page',
    )
    expect(err.statusCode).toBe(503)
    expect(err.statusMessage).toBe('Service temporarily unavailable')
    expect(err.statusMessage).not.toMatch(/SQLSTATE|jsonapi|\.php/)
  })

  it('reports a missing entity as a 404 the UI can phrase as "not found"', async () => {
    const err = await upstreamError(new Response('', { status: 404 }), 'GET /jsonapi/node/kb_page')
    expect(err.statusCode).toBe(404)
  })

  it('keeps a 422\'s JSON:API violations for the per-field mapping', async () => {
    const body = JSON.stringify({
      errors: [{
        status: '422',
        detail: 'title: This value should not be null.',
        source: { pointer: '/data/attributes/title' },
        links: { info: { href: 'http://internal/should-not-leak' } },
      }],
    })
    const err = await upstreamError(new Response(body, { status: 422 }), 'PATCH /jsonapi/node/kb_page/x')
    expect(err.statusCode).toBe(422)
    expect(err.data).toEqual({
      violations: [{
        detail: 'title: This value should not be null.',
        source: { pointer: '/data/attributes/title' },
      }],
    })
  })

  it('a 422 without a JSON body carries no violations', async () => {
    const err = await upstreamError(new Response('nope', { status: 422 }), 'PATCH /x')
    expect(err.statusCode).toBe(422)
    expect(err.data).toBeUndefined()
  })

  // A route can refuse for several reasons that ask the caller for different
  // things, and only Drupal's own sentence tells them apart.
  it('reports a 403 in the upstream\'s own words', async () => {
    const body = JSON.stringify({
      errors: [{ detail: 'editor2 may not update this page.' }],
    })
    const err = await upstreamError(new Response(body, { status: 403 }), 'POST /openkb/node/9/commit')
    expect(err.statusCode).toBe(403)
    expect(err.statusMessage).toBe('editor2 may not update this page.')
  })

  it('falls back to the status where the upstream worded nothing', async () => {
    const err = await upstreamError(new Response('', { status: 403 }), 'POST /openkb/node/9/commit')
    expect(err.statusMessage).toBe('Request failed (403)')
  })

  it('keeps every other status generic, whatever the upstream wrote', async () => {
    const body = JSON.stringify({ errors: [{ detail: 'The current user is not allowed to GET the field "mail".' }] })
    const err = await upstreamError(new Response(body, { status: 404 }), 'GET /openkb/node/9')
    expect(err.statusMessage).toBe('Request failed (404)')
  })
})
