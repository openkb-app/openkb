import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { computed, ref, nextTick, type Ref } from 'vue'
import type { KbSpaceListItem, KbSpaceTree, Outline } from '#shared/utils/kb-outline'
import type { KbPageListItem } from '#shared/utils/kb-spaces'
import { useKbPages, useSpaces } from './useOkbChromeData'
import { useKbOutline } from './useKbOutline'

/**
 * The write side of the navigation composable.
 *
 * Every move replaces the whole tree and names the tree it replaces, so two of
 * them in flight at once would have the second refused against a tree the first
 * has not stored yet. This pins that the composable never puts two in the air,
 * that each write names the tree the field actually holds, and that a refusal
 * leaves the reader looking at Drupal's answer rather than at a guess.
 *
 * The composable reaches for Nuxt's auto-imports, which are globals at runtime;
 * they are stubbed here with the smallest thing that behaves like them.
 */

const SPACE_ID = 'space-uuid'

function page(id: string): KbPageListItem {
  return { id, title: id, path: `/kb/${id}`, space: { id: SPACE_ID, name: 'General' } } as KbPageListItem
}

function stubNuxt(outline: Outline, pages: KbPageListItem[]) {
  const spaces: KbSpaceListItem[] = [{
    id: SPACE_ID,
    name: 'General',
    internalId: 7,
    slug: 'general',
    description: '',
    readAccess: 'members_only',
    moderation: true,
    outline,
    canManage: true,
    canWrite: true,
  }]
  const states = new Map<string, Ref<unknown>>()
  const refreshed: string[] = []

  vi.stubGlobal('computed', computed)
  vi.stubGlobal('useState', (key: string, init: () => unknown) => {
    if (!states.has(key)) states.set(key, ref(init()))
    return states.get(key)!
  })
  vi.stubGlobal('useFetch', (url: string) => ({
    data: ref(url === '/api/kb' ? pages : spaces),
    refresh: async () => { refreshed.push(url) },
  }))
  vi.stubGlobal('useToast', () => ({ add: () => {} }))
  return { refreshed }
}

/** A `$fetch` that answers writes only when the test says so. */
function deferredFetch() {
  const calls: Array<{ outline: Outline, expect: Outline, resolve: (value: Outline) => void }> = []
  vi.stubGlobal('$fetch', (_url: string, init: { body: { outline: Outline, expect: Outline } }) =>
    new Promise<{ outline: Outline }>((resolve) => {
      calls.push({
        outline: init.body.outline,
        expect: init.body.expect,
        resolve: stored => resolve({ outline: stored }),
      })
    }))
  return calls
}

describe('useKbOutline moves', () => {
  beforeEach(() => {
    vi.stubGlobal('console', { ...console, error: () => {} })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('sends one write at a time, in the order the moves were made', async () => {
    // Two drags in a row are one gesture to the person doing them. The second
    // must reach Drupal after the first has landed, or the first overwrites it.
    stubNuxt([{ id: 'a' }, { id: 'b' }, { id: 'c' }], ['a', 'b', 'c'].map(page))
    const calls = deferredFetch()
    const { trees, move } = useKbOutline()

    const space = () => trees.value[0] as KbSpaceTree
    // b under a, then c under b — the three-level tree, dragged at speed.
    const first = move(space(), 'b', { parentId: 'a', index: 0 })
    await nextTick()
    const second = move(space(), 'c', { parentId: 'b', index: 0 })
    await nextTick()

    expect(calls).toHaveLength(1)
    expect(calls[0]!.outline).toEqual([
      { id: 'a', children: [{ id: 'b', children: [] }] }, { id: 'c', children: [] },
    ])

    calls[0]!.resolve(calls[0]!.outline)
    await first
    expect(calls).toHaveLength(2)
    expect(calls[1]!.outline).toEqual([
      { id: 'a', children: [{ id: 'b', children: [{ id: 'c', children: [] }] }] },
    ])
    // The second write names what the first one left behind, so the pair is
    // one chain rather than two writers racing.
    expect(calls[1]!.expect).toEqual(calls[0]!.outline)

    calls[1]!.resolve(calls[1]!.outline)
    await second
    // Both moves are shown, and the tree the caller sees is the one stored.
    expect(space().outline).toEqual(calls[1]!.outline)
  })

  it('shows a move before its write leaves', async () => {
    // The optimistic paint is what makes a drag feel like moving a thing.
    stubNuxt([{ id: 'a' }, { id: 'b' }], ['a', 'b'].map(page))
    deferredFetch()
    const { trees, move } = useKbOutline()

    void move(trees.value[0] as KbSpaceTree, 'b', { parentId: 'a', index: 0 })
    await nextTick()
    expect((trees.value[0] as KbSpaceTree).outline).toEqual([
      { id: 'a', children: [{ id: 'b', children: [] }] },
    ])
  })

  it('puts the tree back and re-reads the spaces when a write is refused', async () => {
    // A refused drag may have lost a race, so the pre-drag tree is itself out
    // of date: the optimistic paint goes and Drupal's answer is fetched.
    const { refreshed } = stubNuxt([{ id: 'a' }, { id: 'b' }], ['a', 'b'].map(page))
    vi.stubGlobal('$fetch', () => Promise.reject(new Error('403')))
    const { trees, move } = useKbOutline()

    await move(trees.value[0] as KbSpaceTree, 'b', { parentId: 'a', index: 0 })
    await nextTick()
    expect((trees.value[0] as KbSpaceTree).outline).toEqual([
      { id: 'a', children: [] }, { id: 'b', children: [] },
    ])
    expect(refreshed).toEqual(['/api/spaces'])
  })

  it('names the tree the field holds, not the one the sweep drew', async () => {
    // The sweep appends pages the stored tree never named. Claiming the
    // swept tree as the stored one would be refused as stale on every drag.
    stubNuxt([{ id: 'b', children: [] }], ['a', 'b'].map(page))
    const calls = deferredFetch()
    const { trees, move } = useKbOutline()

    const space = trees.value[0] as KbSpaceTree
    expect(space.outline).toEqual([{ id: 'b', children: [] }, { id: 'a', children: [] }])
    void move(space, 'a', { parentId: 'b', index: 0 })
    await nextTick()

    expect(calls[0]!.expect).toEqual([{ id: 'b', children: [] }])
    expect(calls[0]!.outline).toEqual([{ id: 'b', children: [{ id: 'a', children: [] }] }])
  })
})

describe('one payload per endpoint', () => {
  afterEach(() => vi.unstubAllGlobals())

  /** A `useFetch` that dedupes by key, the way Nuxt's does. */
  function stubKeyedFetch(asked: Array<{ url: string, key: string }>) {
    const entries = new Map<string, { data: Ref<unknown>, refresh: () => Promise<void> }>()
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('useState', (_key: string, init: () => unknown) => ref(init()))
    vi.stubGlobal('useToast', () => ({ add: () => {} }))
    vi.stubGlobal('useFetch', (url: string, options: { key: string, default: () => unknown }) => {
      asked.push({ url, key: options.key })
      if (!entries.has(options.key)) {
        entries.set(options.key, { data: ref(options.default()), refresh: async () => {} })
      }
      return entries.get(options.key)!
    })
  }

  it('gives the outline and the chrome the same lists, under one key each', () => {
    // Two keys over one endpoint means two independently fetched copies, and
    // the server pass and the hydration pass are then free to disagree — which
    // is what leaves the sidebar tree stuck read-only after a mismatch.
    const asked: Array<{ url: string, key: string }> = []
    stubKeyedFetch(asked)

    const outline = useKbOutline()

    expect(outline.spaces).toBe(useSpaces().spaces)
    expect(outline.pages).toBe(useKbPages().pages)
    expect([...new Set(asked.map(entry => `${entry.url} ${entry.key}`))].sort()).toEqual([
      '/api/kb okb-pages',
      '/api/spaces okb-spaces',
    ])
  })
})
