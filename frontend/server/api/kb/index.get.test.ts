import { describe, it, expect, vi, beforeEach } from 'vitest'
import handler from './index.get'
import { makeEvent } from '../../test-support/h3'

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

/**
 * A kb_page collection as core's JSON:API pages it: 50 rows from
 * `page[offset]`, and a `next` link only while more rows follow. `delay` lets
 * a later page answer before an earlier one.
 */
function collection(rows: ReturnType<typeof page>[], delay: (offset: number) => number = () => 0) {
  const seen = { calls: 0, inFlight: 0, maxInFlight: 0 }
  const respond = async (_event: unknown, path: string) => {
    seen.calls++
    seen.inFlight++
    seen.maxInFlight = Math.max(seen.maxInFlight, seen.inFlight)
    const offset = Number(/[?&]page\[offset\]=(\d+)/.exec(path)?.[1] ?? 0)
    await new Promise(resolve => setTimeout(resolve, delay(offset)))
    seen.inFlight--
    const data = rows.slice(offset, offset + 50)
    const next = rows.length > offset + 50
      ? { links: { next: { href: `http://drupal.test/jsonapi/node/kb_page?page[offset]=${offset + 50}` } } }
      : {}
    return { data, included: data.length ? [SPACE] : [], ...next }
  }
  return { respond, seen }
}

describe('GET /api/kb', () => {
  beforeEach(() => {
    drupalFetch.mockReset()
  })

  it('carries the page UUID — the id the space outline names it by', async () => {
    drupalFetch.mockResolvedValue({ data: [page('a')], included: [SPACE] })
    const result = await handler(makeEvent())
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
    const result = await handler(makeEvent()) as Array<{ changed: number }>
    expect(result[0]!.changed).toBe(Date.parse('2026-07-20T10:00:00+00:00'))
    // Sorting must not float an unknown edit date to the top of "recent".
    expect(result[1]!.changed).toBe(0)
  })

  it('reads every page, so a >50-page space arrives whole', async () => {
    const rows = Array.from({ length: 87 }, (_, i) => page(`a${i}`))
    const drupal = collection(rows)
    drupalFetch.mockImplementation(drupal.respond)

    const result = await handler(makeEvent())
    expect(result.map(item => item.id)).toEqual(rows.map(row => row.id))
    expect(drupalFetch).toHaveBeenCalledTimes(2)
    expect(drupalFetch.mock.calls[1]![1]).toContain('page[offset]=50')
  })

  it('costs one request when the KB fits one page', async () => {
    const drupal = collection(Array.from({ length: 50 }, (_, i) => page(`a${i}`)))
    drupalFetch.mockImplementation(drupal.respond)

    expect(await handler(makeEvent())).toHaveLength(50)
    expect(drupal.seen.calls).toBe(1)
  })

  it('reads a large KB several pages at a time, in the collection order', async () => {
    // 5,234 rows are 105 pages. Later pages answer first, which must not
    // reorder the list: the outline appends unplaced pages in this order.
    const rows = Array.from({ length: 5234 }, (_, i) => page(`p${i}`))
    const drupal = collection(rows, offset => (offset / 50) % 3 === 0 ? 3 : 0)
    drupalFetch.mockImplementation(drupal.respond)

    const result = await handler(makeEvent())
    expect(result.map(item => item.id)).toEqual(rows.map(row => row.id))
    expect(drupal.seen.maxInFlight).toBe(6)
    // A last wave may overshoot the end by a few empty pages.
    expect(drupal.seen.calls).toBeGreaterThanOrEqual(105)
    expect(drupal.seen.calls).toBeLessThanOrEqual(105 + 5)
  })

  it('never asks for more pages than twice the list needs', async () => {
    for (const length of [0, 1, 51, 100, 101, 151, 201, 401, 1001]) {
      drupalFetch.mockReset()
      const rows = Array.from({ length }, (_, i) => page(`a${i}`))
      const drupal = collection(rows)
      drupalFetch.mockImplementation(drupal.respond)

      const result = await handler(makeEvent())
      expect(result).toHaveLength(length)
      const needed = Math.max(1, Math.ceil(length / 50))
      expect(drupal.seen.calls).toBeLessThanOrEqual(Math.min(2 * needed, needed + 5))
    }
  })

  it('fails rather than answer part of the list when a page fails', async () => {
    // A partial list would drop pages from the navigation without a trace.
    const drupal = collection(Array.from({ length: 300 }, (_, i) => page(`a${i}`)))
    drupalFetch.mockImplementation((event: unknown, path: string) =>
      path.includes('page[offset]=150') ? Promise.reject(new Error('upstream down')) : drupal.respond(event, path))

    await expect(handler(makeEvent())).rejects.toThrow('upstream down')
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

    const result = await handler(makeEvent())
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

    const result = await handler(makeEvent())
    expect(result).toHaveLength(1)
    expect(drupalFetch).toHaveBeenCalledTimes(2)
  })

  it('pages on a total order, so no row can straddle a page boundary', async () => {
    drupalFetch.mockResolvedValue({ data: [page('a')], included: [SPACE] })
    await handler(makeEvent())
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

    const result = await handler(makeEvent())
    expect(result.map(item => item.id)).toEqual(['a', 'b', 'c'])
  })

  it('reports a page with no space as unassigned, not as broken', async () => {
    drupalFetch.mockResolvedValue({
      data: [{ id: 'a', attributes: { title: 'A', path: null }, relationships: {} }],
    })
    const result = await handler(makeEvent())
    expect(result).toEqual([{ id: 'a', title: 'A', path: '', space: null, changed: 0 }])
  })
})
