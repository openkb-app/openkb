import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const drupalFetchWithAuth = vi.fn()

vi.mock('./drupal', async importOriginal => ({
  ...(await importOriginal<typeof import('./drupal')>()),
  drupalFetchWithAuth,
}))

const { resolveDocNids } = await import('./doc-links')

/** One page as JSON:API answers it. */
function page(nid: number, title: string, alias: string | null = `/kb/${nid}`) {
  return { attributes: { drupal_internal__nid: nid, title, path: alias ? { alias } : null } }
}

const NEXT = { next: { href: 'http://drupal.internal/jsonapi/node/kb_page?page%5Boffset%5D=50' } }

describe('resolveDocNids', () => {
  beforeEach(() => drupalFetchWithAuth.mockReset())
  afterEach(() => vi.restoreAllMocks())

  it('follows the collection to its end', async () => {
    drupalFetchWithAuth
      .mockResolvedValueOnce({ data: [page(1, 'One'), page(2, 'Two')], links: NEXT })
      .mockResolvedValueOnce({ data: [page(3, 'Three')] })

    // A target missing from the answer renders as unreadable, so every page
    // of the collection has to be read.
    expect(await resolveDocNids({}, [1, 2, 3])).toEqual({
      1: { title: 'One', path: '/kb/1' },
      2: { title: 'Two', path: '/kb/2' },
      3: { title: 'Three', path: '/kb/3' },
    })
    expect(drupalFetchWithAuth).toHaveBeenCalledTimes(2)
    expect(drupalFetchWithAuth.mock.calls[1]![1]).toBe('/jsonapi/node/kb_page?page%5Boffset%5D=50')
  })

  it('keeps what arrived when the read fails', async () => {
    drupalFetchWithAuth
      .mockResolvedValueOnce({ data: [page(1, 'One')], links: NEXT })
      .mockRejectedValueOnce(new Error('upstream gone'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    // A failed read leaves targets unresolved; the stored labels still render.
    expect(await resolveDocNids({}, [1, 2])).toEqual({ 1: { title: 'One', path: '/kb/1' } })
  })

  it('stops on a next that does not advance', async () => {
    drupalFetchWithAuth.mockResolvedValue({ data: [page(1, 'One')], links: NEXT })

    expect(await resolveDocNids({}, [1])).toEqual({ 1: { title: 'One', path: '/kb/1' } })
    expect(drupalFetchWithAuth).toHaveBeenCalledTimes(2)
  })

  it('leaves a page with no alias unresolved', async () => {
    drupalFetchWithAuth.mockResolvedValueOnce({ data: [page(1, 'One', null)] })
    expect(await resolveDocNids({}, [1])).toEqual({})
  })

  it('asks nothing when nothing is linked', async () => {
    expect(await resolveDocNids({}, [])).toEqual({})
    expect(drupalFetchWithAuth).not.toHaveBeenCalled()
  })
})
