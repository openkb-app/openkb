import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { searchKbPages } from './kb-search'
import { makeEvent, stubFetch, type Reply } from '../test-support/h3'

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

const ANSWER = {
  pages: [{
    nid: 7,
    title: 'Rotation notes',
    path: '/team-wiki/rotation-notes',
    space: 'Team Wiki',
    type: 'runbook',
    highlights: ['Rotation notes'],
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

describe('searchKbPages', () => {
  it('asks Drupal for the pages a typed prefix offers', async () => {
    const calls = reply()
    await searchKbPages(makeEvent(), { q: 'Rel' })

    const url = new URL(calls[0]!.url)
    expect(url.pathname).toBe('/openkb/search')
    expect(url.searchParams.get('title')).toBe('Rel')
    expect(url.searchParams.get('q')).toBeNull()
  })

  it('narrows the offers to a space when one is asked for', async () => {
    const calls = reply()
    await searchKbPages(makeEvent(), { q: 'Rel', space: 'team-wiki' })
    expect(new URL(calls[0]!.url).searchParams.get('space')).toBe('team-wiki')

    const unscoped = reply()
    await searchKbPages(makeEvent(), { q: 'Rel' })
    expect(new URL(unscoped[0]!.url).searchParams.get('space')).toBeNull()
  })

  it('lists the newest pages when the query is empty', async () => {
    // A bare `[[` opens the picker on this query: there is no prefix to match,
    // so the listing arm is what still offers pages.
    const calls = reply()
    await searchKbPages(makeEvent(), { q: '  ' })

    const url = new URL(calls[0]!.url)
    expect(url.searchParams.get('q')).toBe('')
    expect(url.searchParams.get('title')).toBeNull()
  })

  it('serves the row contract the picker and the suggest consume', async () => {
    reply()
    expect(await searchKbPages(makeEvent(), { q: 'Rel' })).toEqual({
      query: 'Rel',
      hits: [{
        nid: 7,
        title: 'Rotation notes',
        path: '/team-wiki/rotation-notes',
        space: 'Team Wiki',
        type: 'runbook',
        highlights: ['Rotation notes'],
      }],
    })
  })

  it('drops a row that names no page to link to', async () => {
    reply({ body: { pages: [{ nid: 7, title: 'Pathless' }] } })
    expect((await searchKbPages(makeEvent(), { q: 'Rel' })).hits).toEqual([])
  })

  // What a viewer is offered is Drupal's to narrow (SearchTitlePrefixTest
  // ::testForeignSpacesAreNeverOffered); that holds only if the suggest asks
  // with the viewer's own session and nothing broader.
  it('asks as the caller, so a viewer is offered only what the viewer may read', async () => {
    const cookie = reply()
    await searchKbPages(makeEvent({ Cookie: 'SESS=viewer' }), { q: 'Rel' })
    expect(cookie[0]!.init.headers).toMatchObject({ Cookie: 'SESS=viewer' })
    expect(cookie[0]!.init.headers).not.toHaveProperty('Authorization')

    const bearer = reply()
    await searchKbPages(makeEvent({ Authorization: 'Bearer viewer-token' }), { q: 'Rel' })
    expect(bearer[0]!.init.headers).toMatchObject({ Authorization: 'Bearer viewer-token' })
    expect(bearer[0]!.init.headers).not.toHaveProperty('Cookie')
  })

  it('fails closed for an anonymous caller', async () => {
    const calls = reply()
    await expect(searchKbPages(makeEvent({}), { q: 'Rel' })).rejects.toMatchObject({ statusCode: 403 })
    expect(calls).toEqual([])
  })

  it('reports a Drupal that will not answer as unavailable', async () => {
    reply({ status: 500 })
    await expect(searchKbPages(makeEvent(), { q: 'Rel' })).rejects.toMatchObject({ statusCode: 503 })
  })

  it('carries a refusal through rather than answering an empty list', async () => {
    reply({ status: 422 })
    await expect(searchKbPages(makeEvent(), { q: 'Rel' })).rejects.toMatchObject({ statusCode: 422 })
  })
})
