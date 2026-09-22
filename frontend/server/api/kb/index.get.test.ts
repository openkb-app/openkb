import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { H3Event } from 'h3'
import handler from './index.get'

/**
 * The list the whole navigation is built from.
 *
 * The sidebar renders whole space trees, so this endpoint may not stop at a
 * JSON:API page boundary: a truncated list would not shorten a tree, it would
 * remove pages from the only navigation that reaches them. It also has to
 * carry each page's UUID, which is the name the space outline stores.
 */

const drupalFetch = vi.fn()

vi.mock('../../utils/drupal', async importOriginal => ({
  ...(await importOriginal<typeof import('../../utils/drupal')>()),
  drupalFetch: (...args: unknown[]) => drupalFetch(...args),
}))

function event(): H3Event {
  return { context: {} } as unknown as H3Event
}

const SPACE = {
  type: 'openkb_space--openkb_space',
  id: 'space-uuid',
  attributes: { label: 'Engineering' },
}

function page(id: string, changed = '2026-07-20T10:00:00+00:00') {
  return {
    id,
    attributes: { title: id.toUpperCase(), path: { alias: `/kb/${id}` }, changed },
    relationships: { field_space: { data: { id: 'space-uuid', type: 'openkb_space--openkb_space' } } },
  }
}

describe('GET /api/kb', () => {
  beforeEach(() => {
    drupalFetch.mockReset()
  })

  it('carries the page UUID — the id the space outline names it by', async () => {
    drupalFetch.mockResolvedValue({ data: [page('a')], included: [SPACE] })
    const result = await handler(event())
    expect(result).toEqual([{
      id: 'a',
      title: 'A',
      path: '/kb/a',
      space: { id: 'space-uuid', name: 'Engineering' },
      changed: Date.parse('2026-07-20T10:00:00+00:00'),
    }])
  })

  it('carries `changed` as epoch milliseconds, and 0 when Drupal sent none', async () => {
    const undated = page('b')
    delete (undated.attributes as { changed?: string }).changed
    drupalFetch.mockResolvedValue({ data: [page('a'), undated], included: [SPACE] })
    const result = await handler(event()) as Array<{ changed: number }>
    expect(result[0]!.changed).toBe(Date.parse('2026-07-20T10:00:00+00:00'))
    // Sorting must not float an unknown edit date to the top of "recent".
    expect(result[1]!.changed).toBe(0)
  })

  it('follows `next` to exhaustion, so a >50-page space arrives whole', async () => {
    const first = Array.from({ length: 50 }, (_, i) => page(`a${i}`))
    const second = Array.from({ length: 37 }, (_, i) => page(`b${i}`))
    drupalFetch
      .mockResolvedValueOnce({
        data: first,
        included: [SPACE],
        links: { next: { href: 'http://drupal.test/jsonapi/node/kb_page?page[offset]=50' } },
      })
      .mockResolvedValueOnce({ data: second, included: [SPACE] })

    const result = await handler(event())
    expect(result).toHaveLength(87)
    expect(drupalFetch).toHaveBeenCalledTimes(2)
    // The next link is reduced to a path: Drupal builds it from its own base
    // URL, which is not the host the Nuxt server talks to.
    expect(drupalFetch.mock.calls[1]![1]).toBe('/jsonapi/node/kb_page?page[offset]=50')
  })

  it('resolves spaces seen on any page, not only the first', async () => {
    const other = { ...SPACE, id: 'space-two', attributes: { label: 'Product' } }
    drupalFetch
      .mockResolvedValueOnce({
        data: [page('a')],
        included: [SPACE],
        links: { next: { href: 'http://drupal.test/jsonapi/node/kb_page?page[offset]=50' } },
      })
      .mockResolvedValueOnce({
        data: [{
          id: 'b',
          attributes: { title: 'B', path: { alias: '/kb/b' } },
          relationships: { field_space: { data: { id: 'space-two', type: 'openkb_space--openkb_space' } } },
        }],
        included: [other],
      })

    const result = await handler(event())
    expect(result.map(item => item.space?.name)).toEqual(['Engineering', 'Product'])
  })

  it('stops on an empty page rather than looping on a trailing `next`', async () => {
    // Drupal still answers `next` on the last full page; only the empty page
    // that follows proves exhaustion.
    drupalFetch
      .mockResolvedValueOnce({
        data: [page('a')],
        included: [SPACE],
        links: { next: { href: 'http://drupal.test/jsonapi/node/kb_page?page[offset]=200' } },
      })
      .mockResolvedValueOnce({
        data: [],
        links: { next: { href: 'http://drupal.test/jsonapi/node/kb_page?page[offset]=400' } },
      })

    const result = await handler(event())
    expect(result).toHaveLength(1)
    expect(drupalFetch).toHaveBeenCalledTimes(2)
  })

  it('pages on a total order, so no row can straddle a page boundary', async () => {
    drupalFetch.mockResolvedValue({ data: [page('a')], included: [SPACE] })
    await handler(event())
    // `created` alone ties across a bulk import; the node id breaks the tie.
    const query = drupalFetch.mock.calls[0]![1] as string
    expect(query).toContain('created')
    expect(query).toContain('drupal_internal__nid')
  })

  it('lists a page once even if two pages carry it', async () => {
    // Consumers key on the UUID — the outline stores it — so a repeat would
    // surface as one page twice in the navigation tree.
    drupalFetch
      .mockResolvedValueOnce({
        data: [page('a'), page('b')],
        included: [SPACE],
        links: { next: { href: 'http://drupal.test/jsonapi/node/kb_page?page[offset]=2' } },
      })
      .mockResolvedValueOnce({ data: [page('b'), page('c')], included: [SPACE] })

    const result = await handler(event())
    expect(result.map(item => item.id)).toEqual(['a', 'b', 'c'])
  })

  it('reports a page with no space as unassigned, not as broken', async () => {
    drupalFetch.mockResolvedValue({
      data: [{ id: 'a', attributes: { title: 'A', path: null }, relationships: {} }],
    })
    const result = await handler(event())
    expect(result).toEqual([{ id: 'a', title: 'A', path: '', space: null, changed: 0 }])
  })
})
