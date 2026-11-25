import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { searchPageSections } from './kb-search'
import { makeEvent, stubFetch, type Reply } from '../test-support/h3'

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

const ANSWER = {
  query: 'rotation',
  page: 0,
  page_size: 10,
  total: null,
  has_more: false,
  pages: [{
    nid: 7,
    title: 'Rotation notes',
    path: '/team-wiki/rotation-notes',
    space: 'Team Wiki',
    type: 'runbook',
    tags: ['on-call'],
    changed: 1758240000,
    score: 0.91,
    sections: [
      {
        block: 'b-4',
        heading_path: ['Rotation notes', 'On call'],
        excerpt: 'Who carries the pager.',
        highlights: ['Who carries the \uE000pager\uE001.'],
        score: 0.91,
        path: '/team-wiki/rotation-notes#b-4',
      },
      {
        block: 'b-9',
        heading_path: ['Rotation notes', 'Handover'],
        excerpt: 'What the next shift is told.',
        score: 0.78,
        path: '/team-wiki/rotation-notes#b-9',
      },
    ],
  }],
}

/** Drupal's answer to every call: the fixture, unless `over` says otherwise. */
const reply = (over: Reply = {}) => stubFetch({ '': { body: ANSWER, ...over } })

beforeEach(() => {
  vi.stubGlobal('useRuntimeConfig', () => ({ drupalBaseUrl: 'http://drupal.test/' }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('searchPageSections', () => {
  it('asks Drupal for the window, carrying the caller’s session', async () => {
    const calls = reply()
    await searchPageSections(makeEvent(), { q: 'rotation', page: 2, space: 'team-wiki' })

    const url = new URL(calls[0]!.url)
    expect(url.pathname).toBe('/openkb/search')
    expect(url.searchParams.get('q')).toBe('rotation')
    expect(url.searchParams.get('page')).toBe('2')
    expect(url.searchParams.get('space')).toBe('team-wiki')
  })

  it('carries the document type to Drupal, and only when one is asked for', async () => {
    const withType = reply()
    await searchPageSections(makeEvent(), { q: 'rotation', type: 'runbook' })
    expect(new URL(withType[0]!.url).searchParams.get('type')).toBe('runbook')

    const without = reply()
    await searchPageSections(makeEvent(), { q: 'rotation' })
    expect(new URL(without[0]!.url).searchParams.has('type')).toBe(false)
  })

  it('answers one row per page, with the sections it matched', async () => {
    reply()
    expect(await searchPageSections(makeEvent(), { q: 'rotation' })).toEqual({
      query: 'rotation',
      page: 0,
      pageSize: 10,
      total: null,
      hasMore: false,
      pages: [{
        nid: 7,
        title: 'Rotation notes',
        path: '/team-wiki/rotation-notes',
        space: 'Team Wiki',
        type: 'runbook',
        tags: ['on-call'],
        changed: 1758240000,
        score: 0.91,
        sections: [
          {
            block: 'b-4',
            headingPath: ['Rotation notes', 'On call'],
            excerpt: 'Who carries the pager.',
            highlights: ['Who carries the \uE000pager\uE001.'],
            score: 0.91,
            path: '/team-wiki/rotation-notes#b-4',
          },
          {
            block: 'b-9',
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
    reply({ body: { ...ANSWER, pages: [{ ...ANSWER.pages[0], path: '' }] } })
    expect((await searchPageSections(makeEvent(), { q: 'rotation' })).pages).toEqual([])
  })

  it('refuses a caller with no session rather than asking Drupal', async () => {
    const calls = reply()
    await expect(searchPageSections(makeEvent({}), { q: 'rotation' }))
      .rejects.toMatchObject({ statusCode: 403 })
    expect(calls).toEqual([])
  })

  it('reports an unreachable Drupal as unavailable, not as no matches', async () => {
    reply({ offline: true })
    await expect(searchPageSections(makeEvent(), { q: 'rotation' }))
      .rejects.toMatchObject({ statusCode: 503 })
  })

  it('reports a refusal with its own status', async () => {
    reply({ status: 403 })
    await expect(searchPageSections(makeEvent(), { q: 'rotation' }))
      .rejects.toMatchObject({ statusCode: 403 })
  })

  it('reports an answer that is not a page list as unavailable', async () => {
    reply({ body: { nothing: true } })
    await expect(searchPageSections(makeEvent(), { q: 'rotation' }))
      .rejects.toMatchObject({ statusCode: 503 })
  })

  it('carries a refused query through as the no-match state', async () => {
    reply({
      status: 422,
      body: { ...ANSWER, pages: [], refused: 'The words of this query were refused.' },
    })
    const answer = await searchPageSections(makeEvent(), { q: 'rotation' })
    expect(answer.pages).toEqual([])
    expect(answer.refused).toBe('The words of this query were refused.')
  })

  it('reports a rejected request as an error, not as no matches', async () => {
    reply({ status: 422, body: { errors: [{ detail: 'A page is a whole number.' }] } })
    await expect(searchPageSections(makeEvent(), { q: 'rotation', page: 99 }))
      .rejects.toMatchObject({ statusCode: 422 })
  })

  it('announces a further window when Drupal says one follows', async () => {
    reply({ body: { ...ANSWER, has_more: true } })
    expect((await searchPageSections(makeEvent(), { q: 'rotation' })).hasMore).toBe(true)
  })
})

describe('the empty query', () => {
  it('asks Drupal for the listing, on the same route', async () => {
    const calls = reply({ body: { ...ANSWER, query: '', pages: [] } })
    const answer = await searchPageSections(makeEvent(), { q: '', page: 3, space: 'team-wiki' })

    const url = new URL(calls[0]!.url)
    expect(url.pathname).toBe('/openkb/search')
    expect(url.searchParams.get('q')).toBe('')
    expect(url.searchParams.get('page')).toBe('3')
    expect(url.searchParams.get('space')).toBe('team-wiki')
    expect(answer.query).toBe('')
  })

  it('reaches no index of its own', async () => {
    const calls = reply({ body: { ...ANSWER, query: '', pages: [] } })
    await searchPageSections(makeEvent(), { q: '' })
    expect(calls.filter(call => call.url.includes('_search'))).toEqual([])
  })

  it('carries the count Drupal answers, where it answers one', async () => {
    reply({ body: { ...ANSWER, query: '', total: 65, pages: [] } })
    expect((await searchPageSections(makeEvent(), { q: '' })).total).toBe(65)
  })

  it('counts nothing for a search, which knows only its window', async () => {
    reply()
    expect((await searchPageSections(makeEvent(), { q: 'rotation' })).total).toBeNull()
  })
})
