/**
 * The per-space page tree: its wire shape, the sweep that keeps it honest, and
 * the pure moves the drag UI performs on it.
 *
 * Structure lives on the space (its `outline` field), not on pages — a
 * nested ordered array of page UUIDs where sibling order *is* array order.
 * So a drag is one write of one field: no node save, no per-page
 * invalidation, no search re-tracking, and nothing that a moderation state
 * could hold back.
 */
import type { KbPageListItem, KbSpace, KbSpaceSummary } from './kb-spaces'

/** One entry of the stored tree. `children` is omitted when there are none. */
export interface OutlineNode {
  id: string
  children?: OutlineNode[]
}

/** A space's whole tree, as stored in the space's `outline` field. */
export type Outline = OutlineNode[]

/** An outline node resolved against the page list, ready to render. */
export interface KbTreeNode {
  page: KbPageListItem
  children: KbTreeNode[]
  /** 0 for a top-level page; used for indentation and collapse depth. */
  depth: number
}

/** Where a dragged node lands: under `parentId` (null = top level), at `index`. */
export interface OutlineDrop {
  parentId: string | null
  index: number
}

/**
 * Parses a stored outline, tolerating everything a field can hold.
 *
 * The field is a plain string sidecar, so an absent, empty or hand-mangled
 * value degrades to "no structure yet" rather than breaking the sidebar —
 * {@link healOutline} then rebuilds a usable tree from the page list alone.
 */
export function parseOutline(raw: string | null | undefined): Outline {
  if (!raw || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? sanitiseOutline(parsed) : []
  }
  catch {
    return []
  }
}

/**
 * One canonical reading of a tree, whatever produced it.
 *
 * Every tree the frontend holds passes through this — a stored field value, a
 * response — so an omitted `children` and an explicit empty one are the same
 * tree. `OutlineResource::normalise()` is the same reading in Drupal, which is
 * what lets the endpoint compare a tree the client sends against the one it
 * stored.
 */
export function sanitiseOutline(nodes: unknown[]): Outline {
  const clean: Outline = []
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue
    const { id, children } = node as { id?: unknown, children?: unknown }
    if (typeof id !== 'string' || !id) continue
    clean.push({ id, children: Array.isArray(children) ? sanitiseOutline(children) : [] })
  }
  return clean
}

/** Every id in the tree, depth-first. */
export function outlineIds(outline: Outline): string[] {
  return outline.flatMap(node => [node.id, ...outlineIds(node.children ?? [])])
}

/**
 * Resolves an outline into renderable nodes — the one walk over the tree.
 *
 * Ids without a page are skipped, an id listed twice is rendered once, and
 * a dropped parent's children rise to where it stood rather than vanishing
 * with it. Uniqueness is the render's own invariant rather than a promise it
 * accepts from its input: the field constraint refuses a duplicate at the
 * JSON:API door, but an entity saved from PHP is not validated, and a page
 * appearing twice in the navigation is worse than one appearing nowhere.
 */
export function buildTree(outline: Outline, pages: KbPageListItem[]): KbTreeNode[] {
  const byId = new Map(pages.map(page => [page.id, page]))
  const rendered = new Set<string>()
  const walk = (nodes: Outline, depth: number): KbTreeNode[] => {
    const built: KbTreeNode[] = []
    for (const node of nodes) {
      const page = byId.get(node.id)
      const children = walk(node.children ?? [], depth + 1)
      if (!page || rendered.has(node.id)) {
        built.push(...children)
        continue
      }
      rendered.add(node.id)
      built.push({ page, children, depth })
    }
    return built
  }
  return walk(outline, 0)
}

/** Drops the render-only fields, back to the stored shape. */
function toOutline(tree: KbTreeNode[]): Outline {
  return tree.map(node => ({ id: node.page.id, children: toOutline(node.children) }))
}

/**
 * Reconciles a stored outline with the pages that actually exist.
 *
 * Two drifts are inevitable and neither may break a render: a page created
 * outside the tree (every creation surface — `node/add`, an agent, a migration
 * — writes a page, not a tree), and a page deleted or moved to another
 * space while the tree still names it. So on read the tree is resolved exactly
 * as it renders, un-placed pages are appended at top level newest-last, and
 * the next structure write persists whatever this produced. No repair job, no
 * write on read.
 *
 * `pages` must already be the space's access-filtered list — what a session
 * may not see is simply not in the tree it gets.
 */
export function healOutline(outline: Outline, pages: KbPageListItem[]): Outline {
  const healed = toOutline(buildTree(outline, pages))
  const placed = new Set(outlineIds(healed))
  // `/api/kb` sorts newest first; appending in reverse puts the newest last, so
  // a freshly created page lands at the bottom of the space where the author
  // expects it rather than jumping to the top of the tree. Marking the id keeps
  // a page list that repeats one — the shape a paginated read can produce —
  // down to a single row.
  for (const page of [...pages].reverse()) {
    if (placed.has(page.id)) continue
    placed.add(page.id)
    healed.push({ id: page.id, children: [] })
  }
  return healed
}

/**
 * The ancestor chain of a page, root first, the page itself last.
 *
 * Empty for a page the tree does not hold — which is what makes breadcrumbs
 * degrade to `Space › page` during the window between a page's creation and
 * the sweep persisting it.
 */
export function trailToPath(tree: KbTreeNode[], path: string): KbTreeNode[] {
  for (const node of tree) {
    if (node.page.path === path) return [node]
    const below = trailToPath(node.children, path)
    if (below.length) return [node, ...below]
  }
  return []
}

/**
 * Adds `id` as the last child of `parentId`.
 *
 * A parent the tree does not hold leaves it untouched, so the new page stays
 * where {@link healOutline} puts it.
 */
export function addChild(outline: Outline, parentId: string, id: string): Outline {
  let placed = false
  const walk = (nodes: Outline): Outline => nodes.map((node) => {
    const children = node.children ?? []
    if (node.id === parentId) {
      placed = true
      return { id: node.id, children: [...children, { id, children: [] }] }
    }
    return { id: node.id, children: walk(children) }
  })
  const next = walk(outline)
  return placed ? next : outline
}

/** Whether `id` sits anywhere below `ancestorId` — the drop guard. */
export function isDescendant(outline: Outline, ancestorId: string, id: string): boolean {
  return outline.some(node => (node.id === ancestorId
    ? outlineIds(node.children ?? []).includes(id)
    : isDescendant(node.children ?? [], ancestorId, id)))
}

interface Detached {
  rest: Outline
  node: OutlineNode | null
  /** Where the node sat before, so a same-list move can compensate for it. */
  from: { parentId: string | null, index: number } | null
}

/** Removes a node and returns the rest of the tree plus the detached subtree. */
function detach(outline: Outline, id: string): Detached {
  let node: OutlineNode | null = null
  let from: Detached['from'] = null
  const walk = (nodes: Outline, parentId: string | null): Outline => {
    const kept: Outline = []
    nodes.forEach((current, index) => {
      if (current.id === id) {
        node = current
        from = { parentId, index }
        return
      }
      kept.push({ id: current.id, children: walk(current.children ?? [], current.id) })
    })
    return kept
  }
  return { rest: walk(outline, null), node, from }
}

/**
 * Moves a subtree — the one operation both drag axes reduce to.
 *
 * Reorder and re-parent differ only in the `parentId` of the drop, so the UI
 * has one code path and the endpoint one payload.
 *
 * `drop.index` is a position in the tree *as rendered* — a caller says "put it
 * where this row is", not "put it where this row will be once the dragged node
 * is gone". Removing the node first shifts its later siblings up by one, so a
 * move within the same list compensates for that here rather than in every
 * caller.
 *
 * Returns the outline unchanged when the move is not allowed or changes
 * nothing, so callers can treat "rejected" and "no-op" alike.
 */
export function moveNode(outline: Outline, id: string, drop: OutlineDrop): Outline {
  if (drop.parentId === id || (drop.parentId && isDescendant(outline, id, drop.parentId))) {
    return outline
  }
  const { rest, node, from } = detach(outline, id)
  if (!node || !from) return outline

  const sameList = from.parentId === drop.parentId
  const index = sameList && from.index < drop.index ? drop.index - 1 : drop.index
  if (sameList && index === from.index) return outline

  const insert = (nodes: Outline): Outline => {
    const at = Math.max(0, Math.min(index, nodes.length))
    return [...nodes.slice(0, at), node, ...nodes.slice(at)]
  }
  if (drop.parentId === null) return insert(rest)

  const walk = (nodes: Outline): Outline => nodes.map(current => (
    current.id === drop.parentId
      ? { id: current.id, children: insert(current.children ?? []) }
      : { id: current.id, children: walk(current.children ?? []) }
  ))
  return walk(rest)
}

/** A space as `GET /api/spaces` lists it — tree and access included. */
export interface KbSpaceListItem extends KbSpaceSummary {
  outline: Outline
  /** Whether the session administers the space — its roster and settings. */
  canManage?: boolean
  /** Whether the session may write in this space — create and edit its pages. */
  canWrite?: boolean
}

/**
 * Whether a session may restructure a space, from what the space payload says.
 *
 * Structure follows content: a space that holds writing to a review bar holds
 * restructuring to the manager bar, and a space with no review lets its writers
 * do both. `OutlineResource::access()` is the same rule in Drupal, which is
 * what the write actually answers to. A space whose flag never arrived reads as
 * moderated, so the stricter bar is what an absent value gets.
 */
export function canRestructure(space: KbSpaceListItem): boolean {
  return space.moderation === false ? space.canWrite === true : space.canManage === true
}

/** One space's navigation, as the sidebar and the landing page render it. */
export interface KbSpaceTree {
  /** `null` for the trailing group of pages with no space. */
  space: KbSpace | null
  slug: string | null
  /** Whether this tree can be rearranged — {@link canRestructure}. */
  canRestructure: boolean
  /** The tree as the field holds it — what a write sends as its `expect`. */
  stored: Outline
  /** The swept outline — what a move is computed against and written back. */
  outline: Outline
  tree: KbTreeNode[]
}

/**
 * The whole navigation: every space the session can see, each with its swept
 * tree, plus a trailing flat group for pages with no space.
 *
 * Built from the two lists the frontend already has — spaces (with their
 * stored outlines) and the access-filtered page list — so the tree a
 * session sees is exactly the pages it may read, with no second access pass.
 * Unassigned pages trail, and stay flat: there is no space to hang an
 * outline on.
 */
export function spaceTrees(
  spaces: KbSpaceListItem[],
  pages: KbPageListItem[],
): KbSpaceTree[] {
  const trees: KbSpaceTree[] = spaces.map((space) => {
    const own = pages.filter(page => page.space?.id === space.id)
    const stored = space.outline ?? []
    const outline = healOutline(stored, own)
    return {
      space: { id: space.id, name: space.name },
      slug: space.slug,
      canRestructure: canRestructure(space),
      stored,
      outline,
      tree: buildTree(outline, own),
    }
  })

  const unassigned = pages.filter(page => !page.space)
  if (unassigned.length) {
    trees.push({
      space: null,
      slug: null,
      canRestructure: false,
      stored: [],
      outline: [],
      tree: unassigned.map(page => ({ page, children: [], depth: 0 })),
    })
  }
  return trees
}

/** The space tree holding a given page, or null. */
export function treeOfPath(trees: KbSpaceTree[], path: string): KbSpaceTree | null {
  return trees.find(group => trailToPath(group.tree, path).length > 0) ?? null
}

/** What placing a new page under the page in context takes. */
export interface NestTarget {
  /** The space whose tree holds the parent — what the outline write addresses. */
  slug: string
  /** The page the new page becomes a child of. */
  parentId: string
  /** The tree to write back, with the new page added to it. */
  outline: Outline
  /** The tree the write claims to be replacing. */
  stored: Outline
}

/**
 * Where a page created from `path` can be nested, or null where it cannot be.
 *
 * Three things have to hold, and each of them can fail on its own: a page is in
 * context at all (home and the space landing pages have none), it belongs to
 * the space being created in, and the session may restructure that space
 * ({@link canRestructure}) — the same signal the drag handle answers to, so the
 * two ways of placing a page are offered together or not at all.
 */
export function nestTarget(
  trees: KbSpaceTree[],
  path: string,
  spaceId: string | null | undefined,
): NestTarget | null {
  if (!spaceId) return null
  const group = trees.find(candidate => candidate.space?.id === spaceId)
  if (!group?.slug || !group.canRestructure) return null
  const parent = trailToPath(group.tree, path).at(-1)
  return parent
    ? { slug: group.slug, parentId: parent.page.id, outline: group.outline, stored: group.stored }
    : null
}
