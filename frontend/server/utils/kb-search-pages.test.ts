import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { H3Event } from 'h3'
import { searchPageSections } from './kb-search'

/**
 * The page arm of `GET /api/kb/search`: Drupal's `/openkb/search`, answering
 * the sections a query matched and — for an empty query — the newest pages.
 * What these pin is the boundary — the query that leaves, the shape that comes
 * back, and that an unanswerable search is an error rather than an empty result
 * the page would show as "no matches".
 *
 * Ranking, the collapse and the listing itself are Drupal's, covered against
 * the live index in openkb_search's ChunkRetrievalTest and SearchListingTest.
 */

function makeEvent(headers: Record<string, string> = { Cookie: 'SESS=x' }): H3Event {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  )
  return { context: {}, node: { req: { headers: lower } } } as unknown as H3Event
}

const ANSWER = {
  query: 'rotation',
  page: 0,
  page_size: 10,
  total: null,
  has_more: false,
  pages: [{
    id: 'entity:node/7:en',
    title: 'Rotation notes',
    path: '/team-wiki/rotation-notes',
    space: 'Team Wiki',
    type: 'runbook',
    tags: ['on-call'],
    changed: 1758240000,
    score: 0.91,
    sections: [
      {
        block_id: 'b-4',
        heading_path: ['Rotation notes', 'On call'],
        excerpt: 'Who carries the pager.',
        highlights: ['Who carries the \uE000pager\uE001.'],
        score: 0.91,
        path: '/team-wiki/rotation-notes#b-4',
      },
      {
        block_id: 'b-9',
        heading_path: ['Rotation notes', 'Handover'],
        excerpt: 'What the next shift is told.',
        score: 0.78,
        path: '/team-wiki/rotation-notes#b-9',
      },
    ],
  }],
}

/** Records every call; answers Drupal's search route. */
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

describe('searchPageSections', () => {
  it('asks Drupal for the window, carrying the caller’s session', async () => {
    const calls = stubFetch()
    await searchPageSections(makeEvent(), { q: 'rotation', page: 2, space: 'team-wiki' })

    const url = new URL(calls[0]!)
    expect(url.pathname).toBe('/openkb/search')
    expect(url.searchParams.get('q')).toBe('rotation')
    expect(url.searchParams.get('page')).toBe('2')
    expect(url.searchParams.get('space')).toBe('team-wiki')
  })

  it('carries the document type to Drupal, and only when one is asked for', async () => {
    const withType = stubFetch()
    await searchPageSections(makeEvent(), { q: 'rotation', type: 'runbook' })
    expect(new URL(withType[0]!).searchParams.get('type')).toBe('runbook')

    const without = stubFetch()
    await searchPageSections(makeEvent(), { q: 'rotation' })
    expect(new URL(without[0]!).searchParams.has('type')).toBe(false)
  })

  it('answers one row per page, with the sections it matched', async () => {
    stubFetch()
    expect(await searchPageSections(makeEvent(), { q: 'rotation' })).toEqual({
      query: 'rotation',
      page: 0,
      pageSize: 10,
      total: null,
      hasMore: false,
      pages: [{
        id: 'entity:node/7:en',
        title: 'Rotation notes',
        path: '/team-wiki/rotation-notes',
        space: 'Team Wiki',
        type: 'runbook',
        tags: ['on-call'],
        changed: 1758240000,
        score: 0.91,
        sections: [
          {
            blockId: 'b-4',
            headingPath: ['Rotation notes', 'On call'],
            excerpt: 'Who carries the pager.',
            highlights: ['Who carries the \uE000pager\uE001.'],
            score: 0.91,
            path: '/team-wiki/rotation-notes#b-4',
          },
          {
            blockId: 'b-9',
            headingPath: ['Rotation notes', 'Handover'],
            excerpt: 'What the next shift is told.',
            highlights: [],
            score: 0.78,
            path: '/team-wiki/rotation-notes#b-9',
          },
        ],
      }],
    })
  })

  it('drops a row that names no page to link to', async () => {
    stubFetch({ answer: { ...ANSWER, pages: [{ ...ANSWER.pages[0], path: '' }] } })
    expect((await searchPageSections(makeEvent(), { q: 'rotation' })).pages).toEqual([])
  })

  it('refuses a caller with no session rather than asking Drupal', async () => {
    const calls = stubFetch()
    await expect(searchPageSections(makeEvent({}), { q: 'rotation' }))
      .rejects.toMatchObject({ statusCode: 403 })
    expect(calls).toEqual([])
  })

  it('reports an unreachable Drupal as unavailable, not as no matches', async () => {
    stubFetch({ offline: true })
    await expect(searchPageSections(makeEvent(), { q: 'rotation' }))
      .rejects.toMatchObject({ statusCode: 503 })
  })

  it('reports a refusal with its own status', async () => {
    stubFetch({ status: 403 })
    await expect(searchPageSections(makeEvent(), { q: 'rotation' }))
      .rejects.toMatchObject({ statusCode: 403 })
  })

  it('reports an answer that is not a page list as unavailable', async () => {
    stubFetch({ answer: { nothing: true } })
    await expect(searchPageSections(makeEvent(), { q: 'rotation' }))
      .rejects.toMatchObject({ statusCode: 503 })
  })

  it('carries a refused query through as the no-match state', async () => {
    stubFetch({
      status: 422,
      answer: { ...ANSWER, pages: [], refused: 'The words of this query were refused.' },
    })
    const answer = await searchPageSections(makeEvent(), { q: 'rotation' })
    expect(answer.pages).toEqual([])
    expect(answer.refused).toBe('The words of this query were refused.')
  })

  it('reports a rejected request as an error, not as no matches', async () => {
    stubFetch({ status: 422, answer: { errors: [{ detail: 'A page is a whole number.' }] } })
    await expect(searchPageSections(makeEvent(), { q: 'rotation', page: 99 }))
      .rejects.toMatchObject({ statusCode: 422 })
  })

  it('announces a further window when Drupal says one follows', async () => {
    stubFetch({ answer: { ...ANSWER, has_more: true } })
    expect((await searchPageSections(makeEvent(), { q: 'rotation' })).hasMore).toBe(true)
  })
})

describe('the empty query', () => {
  it('asks Drupal for the listing, on the same route', async () => {
    const calls = stubFetch({ answer: { ...ANSWER, query: '', pages: [] } })
    const answer = await searchPageSections(makeEvent(), { q: '', page: 3, space: 'team-wiki' })

    const url = new URL(calls[0]!)
    expect(url.pathname).toBe('/openkb/search')
    expect(url.searchParams.get('q')).toBe('')
    expect(url.searchParams.get('page')).toBe('3')
    expect(url.searchParams.get('space')).toBe('team-wiki')
    expect(answer.query).toBe('')
  })

  it('reaches no index of its own', async () => {
    const calls = stubFetch({ answer: { ...ANSWER, query: '', pages: [] } })
    await searchPageSections(makeEvent(), { q: '' })
    expect(calls.filter(url => url.includes('_search'))).toEqual([])
  })

  it('carries the count Drupal answers, where it answers one', async () => {
    stubFetch({ answer: { ...ANSWER, query: '', total: 65, pages: [] } })
    expect((await searchPageSections(makeEvent(), { q: '' })).total).toBe(65)
  })

  it('counts nothing for a search, which knows only its window', async () => {
    stubFetch()
    expect((await searchPageSections(makeEvent(), { q: 'rotation' })).total).toBeNull()
  })
})
