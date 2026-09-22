import {
  moveNode,
  spaceTrees,
  trailToPath,
  treeOfPath,
  type KbSpaceTree,
  type KbTreeNode,
  type Outline,
  type OutlineDrop,
} from '#shared/utils/kb-outline'
import { useKbPages, useSpaces } from './useOkbChromeData'

/**
 * The knowledge base's navigation, as one reactive value.
 *
 * The sidebar tree and the breadcrumb trail are the two renderers of it and
 * cannot drift: both are computed from the same `trees`, so a drag repaints
 * both in the same tick — including the trail of the page being read or
 * edited.
 *
 * Both lists come from the chrome composables, which hold the one key per
 * endpoint the whole app reads through — so a render carries a single copy of
 * each payload, and the sidebar tree cannot disagree with the navbar about
 * what the server sent. The optimistic overrides live in `useState`, which is
 * per-request on the server and a singleton on the client.
 */
export function useKbOutline() {
  const { pages, refreshPages } = useKbPages()
  const { spaces, refreshSpaces } = useSpaces()

  // A confirmed or in-flight drag, keyed by space UUID. Held apart from the
  // fetched value so a later refresh of `/api/spaces` cannot resurrect the
  // pre-drag tree while the PATCH is still in the air.
  const overrides = useState<Record<string, Outline>>('kb-outline-overrides', () => ({}))

  const trees = computed<KbSpaceTree[]>(() => spaceTrees(
    (spaces.value ?? []).map(space => (
      overrides.value[space.id] ? { ...space, outline: overrides.value[space.id]! } : space
    )),
    pages.value ?? [],
  ))

  const toast = useToast()

  // Per space: the tail of its write chain, and the ticket of its newest move.
  // Every write names the tree it replaces, so two in flight at once would have
  // the second refused as stale against a tree the first has not stored yet.
  // Hence one write in the air per space, in gesture order; the ticket is how a
  // settled write tells whether a newer move already replaced what it would
  // paint.
  const chains = new Map<string, { queue: Promise<void>, ticket: number }>()

  /**
   * Persists a move, showing it immediately and repainting if it is refused —
   * a 403 from a session that may not restructure, a 409 from a drag that lost
   * a race, or a 422 from the field constraint.
   *
   * A refusal drops the optimistic tree and re-reads the spaces, so what the
   * user is left looking at is what Drupal holds. That matters most for the
   * lost race: the pre-drag tree is itself out of date by then, and putting it
   * back would hide somebody else's reorganisation rather than show it.
   */
  async function move(space: KbSpaceTree, id: string, drop: OutlineDrop): Promise<void> {
    if (!space.space || !space.slug) return
    const spaceId = space.space.id
    const slug = space.slug
    const next = moveNode(space.outline, id, drop)
    if (next === space.outline) return

    const chain = chains.get(spaceId)
    const ticket = (chain?.ticket ?? 0) + 1
    const newest = () => chains.get(spaceId)?.ticket === ticket
    const paint = (outline: Outline | undefined): void => {
      const painted = { ...overrides.value }
      if (outline) painted[spaceId] = outline
      else delete painted[spaceId]
      overrides.value = painted
    }

    paint(next)
    const queue = (chain?.queue ?? Promise.resolve()).then(async () => {
      try {
        const result = await $fetch<{ outline: Outline }>(`/api/spaces/${slug}/outline`, {
          method: 'PATCH',
          body: { outline: next, expect: space.stored },
        })
        if (newest()) paint(result.outline)
      }
      catch (error) {
        console.error('[kb-outline] move rejected:', error)
        toast.add({
          title: 'Page not moved',
          description: 'The change could not be saved. The tree has been put back.',
          icon: 'i-lucide-triangle-alert',
          color: 'error',
        })
        if (!newest()) return
        paint(undefined)
        await refreshSpaces()
      }
    })
    chains.set(spaceId, { queue, ticket })
    await queue
  }

  /**
   * The ancestor chain of a page, root first, the page last.
   *
   * A page no tree holds still reports its space — resolved from the page
   * list — with an empty chain, which is what lets the breadcrumbs degrade to
   * `Space › page` instead of losing their orientation entirely.
   */
  function trailFor(path: string): { space: KbSpaceTree | null, nodes: KbTreeNode[] } {
    const space = treeOfPath(trees.value, path)
    if (space) return { space, nodes: trailToPath(space.tree, path) }

    const page = (pages.value ?? []).find(item => item.path === path)
    const fallback = page?.space
      ? trees.value.find(group => group.space?.id === page.space!.id) ?? null
      : null
    return { space: fallback, nodes: [] }
  }

  return { trees, pages, spaces, move, trailFor, refreshPages }
}
