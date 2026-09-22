import { describe, expect, it } from 'vitest'
import {
  addChild,
  buildTree,
  canRestructure,
  healOutline,
  isDescendant,
  moveNode,
  nestTarget,
  outlineIds,
  parseOutline,
  spaceTrees,
  trailToPath,
  treeOfPath,
  type KbSpaceListItem,
  type Outline,
} from './kb-outline'
import type { KbPageListItem } from './kb-spaces'

const eng = { id: 'space-eng', name: 'Engineering' }
const product = { id: 'space-prod', name: 'Product & Design' }

function page(id: string, space: KbPageListItem['space'] = eng): KbPageListItem {
  return { id, title: id.toUpperCase(), path: `/${id}`, space }
}

/** A readable rendering of a tree's shape, for order + nesting assertions. */
function shape(outline: Outline): string {
  return outline
    .map(node => (node.children?.length ? `${node.id}(${shape(node.children)})` : node.id))
    .join(',')
}

/** One space as `/api/spaces` lists it — tree and access included. */
function space(
  base: { id: string, name: string },
  outline: Outline,
  access: { canManage?: boolean, canWrite?: boolean, moderation?: boolean } = {},
): KbSpaceListItem {
  return {
    ...base,
    internalId: 1,
    slug: base.name.toLowerCase(),
    description: '',
    readAccess: 'members_only',
    moderation: access.moderation ?? true,
    outline,
    canManage: access.canManage ?? false,
    // A manager writes too — the ranks are one scale.
    canWrite: access.canWrite ?? access.canManage ?? false,
  }
}

describe('parseOutline', () => {
  it('reads a stored tree', () => {
    expect(parseOutline('[{"id":"a","children":[{"id":"b"}]}]'))
      .toEqual([{ id: 'a', children: [{ id: 'b', children: [] }] }])
  })

  it('degrades to no structure rather than throwing', () => {
    // A sidecar string field can hold anything; none of it may break a render.
    expect(parseOutline(null)).toEqual([])
    expect(parseOutline('')).toEqual([])
    expect(parseOutline('   ')).toEqual([])
    expect(parseOutline('{not json')).toEqual([])
    expect(parseOutline('{"id":"a"}')).toEqual([])
  })

  it('drops entries that carry no usable id', () => {
    expect(parseOutline('[{"id":"a"},"loose",{"nope":1},{"id":""}]'))
      .toEqual([{ id: 'a', children: [] }])
  })
})

describe('canRestructure', () => {
  it('holds a moderated space to its managers', () => {
    const moderated = { moderation: true }
    expect(canRestructure(space(eng, [], { ...moderated, canManage: true }))).toBe(true)
    expect(canRestructure(space(eng, [], { ...moderated, canWrite: true }))).toBe(false)
    expect(canRestructure(space(eng, [], moderated))).toBe(false)
  })

  it('lets a writer restructure a space that runs no review', () => {
    const wiki = { moderation: false }
    expect(canRestructure(space(eng, [], { ...wiki, canManage: true }))).toBe(true)
    expect(canRestructure(space(eng, [], { ...wiki, canWrite: true }))).toBe(true)
    expect(canRestructure(space(eng, [], wiki))).toBe(false)
  })

  it('holds a space that reports no review flag to the manager bar', () => {
    // Fail closed: only an explicit "no review" opens restructuring to writers.
    const unflagged = { ...space(eng, [], { canWrite: true }), moderation: undefined }
    expect(canRestructure(unflagged as unknown as KbSpaceListItem)).toBe(false)
    const managed = { ...space(eng, [], { canManage: true }), moderation: undefined }
    expect(canRestructure(managed as unknown as KbSpaceListItem)).toBe(true)
  })
})

describe('healOutline', () => {
  it('appends pages the tree does not hold, newest last', () => {
    // `/api/kb` sorts newest first — a page created just now must land at the
    // bottom of its space, not jump to the top.
    const healed = healOutline(
      [{ id: 'old' }],
      [page('newest'), page('newer'), page('old')],
    )
    expect(shape(healed)).toBe('old,newer,newest')
  })

  it('drops ids with no page and keeps their children in place', () => {
    // A deleted parent must not take a live subtree out of the navigation.
    const healed = healOutline(
      [{ id: 'gone', children: [{ id: 'kept', children: [{ id: 'deep' }] }] }],
      [page('kept'), page('deep')],
    )
    expect(shape(healed)).toBe('kept(deep)')
  })

  it('drops a duplicate id rather than rendering a page twice', () => {
    const healed = healOutline([{ id: 'a' }, { id: 'a' }], [page('a')])
    expect(shape(healed)).toBe('a')
  })

  it('builds the whole tree from the page list when nothing is stored', () => {
    expect(shape(healOutline([], [page('b'), page('a')]))).toBe('a,b')
  })

  it('leaves a tree that already matches untouched', () => {
    const outline: Outline = [{ id: 'a', children: [{ id: 'b' }] }]
    expect(shape(healOutline(outline, [page('a'), page('b')]))).toBe('a(b)')
  })

  it('drops a page that moved to another space', () => {
    const healed = healOutline(
      [{ id: 'a' }, { id: 'moved' }],
      [page('a')],
    )
    expect(shape(healed)).toBe('a')
  })

  it('leaves a freshly written tree exactly as written', () => {
    // The read straight after a structure write, which is where a sweep that
    // over-appends would show: a page placed a moment ago must not also appear
    // at the top level, or the tree grows a copy of itself on every write.
    const written: Outline = [
      { id: 'seed' },
      { id: 'one', children: [{ id: 'two', children: [{ id: 'three' }] }] },
    ]
    const healed = healOutline(
      written,
      [page('three'), page('two'), page('one'), page('seed')],
    )
    expect(shape(healed)).toBe('seed,one(two(three))')
    expect(outlineIds(healed)).toHaveLength(4)
  })

  it('places a page the list repeats exactly once', () => {
    // The list is the sweep's only notion of what exists; a repeat in it — a
    // paginated read over a non-unique sort once produced one — must not become
    // the same page twice in the navigation.
    const healed = healOutline([], [page('a'), page('b'), page('a')])
    expect(shape(healed)).toBe('a,b')
  })
})

describe('buildTree', () => {
  it('resolves ids to pages and carries depth', () => {
    const tree = buildTree(
      [{ id: 'a', children: [{ id: 'b', children: [{ id: 'c' }] }] }],
      [page('a'), page('b'), page('c')],
    )
    expect(tree).toHaveLength(1)
    expect(tree[0]!.depth).toBe(0)
    expect(tree[0]!.children[0]!.depth).toBe(1)
    expect(tree[0]!.children[0]!.children[0]!.page.id).toBe('c')
  })

  it('renders a raw outline as safely as a healed one', () => {
    const tree = buildTree([{ id: 'ghost', children: [{ id: 'a' }] }], [page('a')])
    expect(tree.map(node => node.page.id)).toEqual(['a'])
  })

  it('renders a page listed twice once, keeping the first placement', () => {
    // The field constraint refuses a duplicate at the JSON:API door, but an
    // entity saved from PHP is never validated — so the render carries the
    // invariant itself rather than trusting its input for it.
    const tree = buildTree(
      [{ id: 'a', children: [{ id: 'b' }] }, { id: 'b' }],
      [page('a'), page('b')],
    )
    expect(tree.map(node => node.page.id)).toEqual(['a'])
    expect(tree[0]!.children.map(node => node.page.id)).toEqual(['b'])
  })
})

describe('trailToPath', () => {
  const tree = buildTree(
    [{ id: 'a', children: [{ id: 'b', children: [{ id: 'c' }] }] }],
    [page('a'), page('b'), page('c')],
  )

  it('returns the ancestor chain, root first and the page last', () => {
    expect(trailToPath(tree, '/c').map(node => node.page.id)).toEqual(['a', 'b', 'c'])
  })

  it('is empty for a page the tree does not hold — the degradation case', () => {
    expect(trailToPath(tree, '/nowhere')).toEqual([])
  })
})

describe('isDescendant', () => {
  const outline: Outline = [{ id: 'a', children: [{ id: 'b', children: [{ id: 'c' }] }] }]

  it('sees through the whole subtree, not just direct children', () => {
    expect(isDescendant(outline, 'a', 'c')).toBe(true)
    expect(isDescendant(outline, 'b', 'c')).toBe(true)
    expect(isDescendant(outline, 'c', 'a')).toBe(false)
    expect(isDescendant(outline, 'a', 'a')).toBe(false)
  })
})

describe('moveNode', () => {
  const flat: Outline = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  it('reorders among siblings using positions as rendered', () => {
    // "Put a where c is" — the caller counts rows on screen, not rows after
    // the dragged one has been lifted out.
    expect(shape(moveNode(flat, 'a', { parentId: null, index: 2 }))).toBe('b,a,c')
    expect(shape(moveNode(flat, 'a', { parentId: null, index: 3 }))).toBe('b,c,a')
    expect(shape(moveNode(flat, 'c', { parentId: null, index: 0 }))).toBe('c,a,b')
  })

  it('re-parents, carrying the whole subtree', () => {
    const outline: Outline = [
      { id: 'a', children: [{ id: 'a1', children: [{ id: 'a2' }] }] },
      { id: 'b' },
    ]
    expect(shape(moveNode(outline, 'a1', { parentId: 'b', index: 0 })))
      .toBe('a,b(a1(a2))')
  })

  it('promotes a nested node to the top level', () => {
    const outline: Outline = [{ id: 'a', children: [{ id: 'a1' }] }, { id: 'b' }]
    expect(shape(moveNode(outline, 'a1', { parentId: null, index: 2 }))).toBe('a,b,a1')
  })

  it('refuses to drop a node into itself or its own descendant', () => {
    const outline: Outline = [{ id: 'a', children: [{ id: 'b', children: [{ id: 'c' }] }] }]
    expect(moveNode(outline, 'a', { parentId: 'a', index: 0 })).toBe(outline)
    expect(moveNode(outline, 'a', { parentId: 'c', index: 0 })).toBe(outline)
  })

  it('returns the same value for a move that changes nothing', () => {
    expect(moveNode(flat, 'b', { parentId: null, index: 1 })).toBe(flat)
    expect(moveNode(flat, 'missing', { parentId: null, index: 0 })).toBe(flat)
  })

  it('leaves the source tree untouched', () => {
    moveNode(flat, 'a', { parentId: 'c', index: 0 })
    expect(shape(flat)).toBe('a,b,c')
  })

  it('produces a tree the id set survives', () => {
    const moved = moveNode(flat, 'a', { parentId: 'c', index: 0 })
    expect(outlineIds(moved).sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('spaceTrees', () => {
  it('gives each space its own swept tree', () => {
    const trees = spaceTrees(
      [space(eng, [{ id: 'e2' }]), space(product, [])],
      [page('e1'), page('e2'), page('p1', product)],
    )
    expect(trees).toHaveLength(2)
    expect(shape(trees[0]!.outline)).toBe('e2,e1')
    expect(shape(trees[1]!.outline)).toBe('p1')
  })

  it('never lets one space hold another space\'s pages', () => {
    // A stale id from a page that moved space must not keep rendering there.
    const trees = spaceTrees(
      [space(eng, [{ id: 'p1' }, { id: 'e1' }])],
      [page('e1'), page('p1', product)],
    )
    expect(shape(trees[0]!.outline)).toBe('e1')
  })

  it('renders no row for a page the session may not read', () => {
    // The tree is the outline intersected with the access-filtered page
    // list, so a viewer of a space whose pages are all unpublished drafts gets
    // the rows its writers get minus those drafts.
    const trees = spaceTrees(
      [space(eng, [{ id: 'published' }, { id: 'draft' }])],
      [page('published')],
    )
    expect(shape(trees[0]!.outline)).toBe('published')
    expect(trees[0]!.tree.map(node => node.page.id)).toEqual(['published'])
  })

  it('trails space-less pages as a flat, un-rearrangeable group', () => {
    const trees = spaceTrees(
      [space(eng, [])],
      [page('e1'), page('orphan', null)],
    )
    const last = trees.at(-1)!
    expect(last.space).toBeNull()
    expect(last.slug).toBeNull()
    expect(last.canRestructure).toBe(false)
    expect(last.tree.map(node => node.page.id)).toEqual(['orphan'])
  })

  it('carries the restructure answer through, so drag is offered where it lands', () => {
    expect(spaceTrees([space(eng, [], { canManage: true })], [page('e1')])[0]!.canRestructure)
      .toBe(true)
    expect(spaceTrees(
      [space(eng, [], { canWrite: true, moderation: false })],
      [page('e1')],
    )[0]!.canRestructure).toBe(true)
    expect(spaceTrees([space(eng, [], { canWrite: true })], [page('e1')])[0]!.canRestructure)
      .toBe(false)
  })

  it('keeps the stored tree beside the swept one, so a write can name it', () => {
    // The sweep appends what the field does not hold; a write that claimed the
    // swept tree as the stored one would be refused as stale on every drag.
    const trees = spaceTrees([space(eng, [{ id: 'e2' }])], [page('e1'), page('e2')])
    expect(shape(trees[0]!.stored)).toBe('e2')
    expect(shape(trees[0]!.outline)).toBe('e2,e1')
  })

  it('locates the space holding a page', () => {
    const trees = spaceTrees(
      [space(eng, []), space(product, [])],
      [page('e1'), page('p1', product)],
    )
    expect(treeOfPath(trees, '/p1')?.space?.id).toBe(product.id)
    expect(treeOfPath(trees, '/nowhere')).toBeNull()
  })
})

describe('addChild', () => {
  const outline: Outline = [{ id: 'a', children: [{ id: 'b' }] }, { id: 'c' }]

  it('files the page last under its parent, at whatever depth', () => {
    expect(shape(addChild(outline, 'a', 'new'))).toBe('a(b,new),c')
    expect(shape(addChild(outline, 'b', 'new'))).toBe('a(b(new)),c')
  })

  it('leaves the tree alone when the parent is not in it', () => {
    expect(addChild(outline, 'gone', 'new')).toBe(outline)
  })
})

describe('nestTarget', () => {
  const trees = (canManage = true) => spaceTrees(
    [
      space(eng, [{ id: 'e1', children: [{ id: 'e2', children: [] }] }], { canManage }),
      space(product, [], { canManage: true }),
    ],
    [page('e1'), page('e2'), page('p1', product)],
  )

  it('names the page in context, its space and the tree to write', () => {
    expect(nestTarget(trees(), '/e1', eng.id)).toEqual({
      slug: 'engineering',
      parentId: 'e1',
      outline: [{ id: 'e1', children: [{ id: 'e2', children: [] }] }],
      stored: [{ id: 'e1', children: [{ id: 'e2', children: [] }] }],
    })
    // A nested page is as much a parent as a top-level one.
    expect(nestTarget(trees(), '/e2', eng.id)?.parentId).toBe('e2')
  })

  it('offers nothing where no page is in context', () => {
    // Home, search, a space landing page: routes no page answers to.
    expect(nestTarget(trees(), '/', eng.id)).toBeNull()
    expect(nestTarget(trees(), '/engineering', eng.id)).toBeNull()
  })

  it('offers nothing when the page in context is in another space', () => {
    expect(nestTarget(trees(), '/p1', eng.id)).toBeNull()
    expect(nestTarget(trees(), '/e1', product.id)).toBeNull()
  })

  it('offers nothing without a space to create in', () => {
    expect(nestTarget(trees(), '/e1', null)).toBeNull()
  })

  it('offers nothing where the session may not restructure the space', () => {
    // Nesting and dragging are the same write; a session offered neither is
    // offered neither here.
    expect(nestTarget(trees(false), '/e1', eng.id)).toBeNull()
  })

  it('offers it to a writer where the space runs no review', () => {
    const wiki = spaceTrees(
      [space(eng, [{ id: 'e1', children: [] }], { canWrite: true, moderation: false })],
      [page('e1')],
    )
    expect(nestTarget(wiki, '/e1', eng.id)?.parentId).toBe('e1')
  })
})

describe('a >50-page space', () => {
  // The spec's page-limit trap: the sidebar renders whole space trees, so a
  // list truncated at a JSON:API page boundary would amputate the navigation.
  const many = Array.from({ length: 137 }, (_, index) => page(`a${index}`))

  it('places every page, at whatever depth', () => {
    const stored: Outline = [{ id: 'a0', children: many.slice(1, 60).map(a => ({ id: a.id })) }]
    const healed = healOutline(stored, many)
    expect(outlineIds(healed)).toHaveLength(137)
    const tree = buildTree(healed, many)
    expect(tree[0]!.children).toHaveLength(59)
    expect(tree).toHaveLength(78)
  })

  it('keeps a deep trail usable', () => {
    // 60 levels of nesting, one inside the next.
    let outline: Outline = [{ id: 'a59' }]
    for (let index = 58; index >= 0; index--) outline = [{ id: `a${index}`, children: outline }]
    const tree = buildTree(outline, many)
    expect(trailToPath(tree, '/a59')).toHaveLength(60)
  })
})
