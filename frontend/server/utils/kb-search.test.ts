import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { H3Event } from 'h3'
import { searchKbPages } from './kb-search'

/**
 * The title-prefix read the `[[` picker and the search box's suggest share,
 * and the Author filter's list beside it. Both are Drupal's answer forwarded
 * (ADR 0010), so what these pin is the request that leaves and the shape that
 * comes back — never a filter applied here.
 *
 * The two-account row and the inversion — remove the filter and a stranger's
 * page is returned — live in tests/playwright/tests/search-access.spec.ts,
 * against the real index.
 */

function makeEvent(headers: Record<string, string> = { Cookie: 'SESS=x' }): H3Event {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  )
  return { context: {}, node: { req: { headers: lower } } } as unknown as H3Event
}

const ANSWER = {
  pages: [{
    id: 'entity:node/7:en',
    title: 'Rotation notes',
    path: '/team-wiki/rotation-notes',
    space: 'Team Wiki',
    type: 'runbook',
    highlights: ['Rotation notes'],
  }],
}

/** Records every call; answers Drupal's search routes. */
function stubFetch(options: { status?: number, answer?: unknown, offline?: boolean } = {}) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    calls.push(String(input))
    if (options.offline) throw new TypeError('fetch failed')
    const status = options.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => options.answer ?? ANSWER,
    } as unknown as Response
  }))
  return calls
}

beforeEach(() => {
  vi.stubGlobal('useRuntimeConfig', () => ({ drupalBaseUrl: 'http://drupal.test/' }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('searchKbPages', () => {
  it('asks Drupal for the pages a typed prefix offers', async () => {
    const calls = stubFetch()
    await searchKbPages(makeEvent(), { q: 'Rel' })

    const url = new URL(calls[0]!)
    expect(url.pathname).toBe('/openkb/search')
    expect(url.searchParams.get('title')).toBe('Rel')
    expect(url.searchParams.get('q')).toBeNull()
  })

  it('narrows the offers to a space when one is asked for', async () => {
    const calls = stubFetch()
    await searchKbPages(makeEvent(), { q: 'Rel', space: 'team-wiki' })
    expect(new URL(calls[0]!).searchParams.get('space')).toBe('team-wiki')

    const unscoped = stubFetch()
    await searchKbPages(makeEvent(), { q: 'Rel' })
    expect(new URL(unscoped[0]!).searchParams.get('space')).toBeNull()
  })

  it('lists the newest pages when the query is empty', async () => {
    // A bare `[[` opens the picker on this query: there is no prefix to match,
    // so the listing arm is what still offers pages.
    const calls = stubFetch()
    await searchKbPages(makeEvent(), { q: '  ' })

    const url = new URL(calls[0]!)
    expect(url.searchParams.get('q')).toBe('')
    expect(url.searchParams.get('title')).toBeNull()
  })

  it('serves the row contract the picker and the suggest consume', async () => {
    stubFetch()
    expect(await searchKbPages(makeEvent(), { q: 'Rel' })).toEqual({
      query: 'Rel',
      hits: [{
        id: 'entity:node/7:en',
        title: 'Rotation notes',
        path: '/team-wiki/rotation-notes',
        space: 'Team Wiki',
        type: 'runbook',
        highlights: ['Rotation notes'],
      }],
    })
  })

  it('drops a row that names no page to link to', async () => {
    stubFetch({ answer: { pages: [{ id: 'entity:node/7:en', title: 'Pathless' }] } })
    expect((await searchKbPages(makeEvent(), { q: 'Rel' })).hits).toEqual([])
  })

  it('fails closed for an anonymous caller', async () => {
    const calls = stubFetch()
    await expect(searchKbPages(makeEvent({}), { q: 'Rel' })).rejects.toMatchObject({ statusCode: 403 })
    expect(calls).toEqual([])
  })

  it('reports a Drupal that will not answer as unavailable', async () => {
    stubFetch({ status: 500 })
    await expect(searchKbPages(makeEvent(), { q: 'Rel' })).rejects.toMatchObject({ statusCode: 503 })
  })

  it('carries a refusal through rather than answering an empty list', async () => {
    stubFetch({ status: 422 })
    await expect(searchKbPages(makeEvent(), { q: 'Rel' })).rejects.toMatchObject({ statusCode: 422 })
  })
})
