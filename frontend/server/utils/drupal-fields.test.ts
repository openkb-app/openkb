import { describe, it, expect, vi, afterEach } from 'vitest'
import { createFieldSource } from './drupal-fields'

const SCHEMA = {
  properties: {
    summary: { type: 'string', 'x-field-name': 'field_summary' },
    owner: {
      type: 'object',
      'x-entity-reference': { entity_type: 'user' },
      'x-field-name': 'field_owner',
    },
  },
  body: { allowedHtml: { p: [] } },
}

/** Records requested URLs and answers them from a per-path map. */
function stubFetch(responses: Record<string, { status?: number, body?: unknown }>) {
  const urls: string[] = []
  const impl = vi.fn(async (input: string | URL) => {
    const url = String(input)
    urls.push(url)
    const match = Object.entries(responses).find(([path]) => url.includes(path))
    const { status = 200, body = {} } = match?.[1] ?? { status: 404 }
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response
  })
  vi.stubGlobal('fetch', impl)
  return { urls, impl }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('createFieldSource', () => {
  it('reads the exposure contract off the published schema', async () => {
    stubFetch({ '/openkb/schema': { body: SCHEMA } })

    expect(await createFieldSource('http://drupal.test/').fetchSpecs()).toEqual([
      { key: 'summary', name: 'field_summary', multiple: false, reference: false },
      { key: 'owner', name: 'field_owner', multiple: false, reference: true, entityType: 'user', bundles: [] },
    ])
  })

  it('carries the body format\'s allowed HTML off the same read', async () => {
    const { urls } = stubFetch({ '/openkb/schema': { body: SCHEMA } })
    const source = createFieldSource('http://drupal.test')

    await source.fetchSpecs()
    expect(await source.fetchAllowedHtml()).toEqual({ p: [] })
    expect(urls).toHaveLength(1)
  })

  it('caches the exposure contract instead of re-fetching it per poll tick', async () => {
    const { urls } = stubFetch({ '/openkb/schema': { body: SCHEMA } })
    let clock = 0
    const source = createFieldSource('http://drupal.test', () => clock)

    await source.fetchSpecs()
    clock = 30_000
    await source.fetchSpecs()
    expect(urls).toHaveLength(1)

    // Past the TTL a site-builder's exposure change has to be picked up.
    clock = 120_000
    await source.fetchSpecs()
    expect(urls).toHaveLength(2)
  })

  it('returns null — never a partial payload — when the schema is unreachable', async () => {
    stubFetch({ '/openkb/schema': { status: 500 } })
    expect(await createFieldSource('http://drupal.test').fetchSpecs()).toBeNull()
  })

  it('does not cache a failed schema fetch', async () => {
    const { urls } = stubFetch({ '/openkb/schema': { status: 503 } })
    const source = createFieldSource('http://drupal.test')

    await source.fetchSpecs()
    await source.fetchSpecs()

    expect(urls).toHaveLength(2)
  })
})
