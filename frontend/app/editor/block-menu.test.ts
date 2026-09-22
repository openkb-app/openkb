import { describe, it, expect, vi } from 'vitest'
import type { PageBlock, ReviewStep } from '#shared/page-blocks'
import {
  approvalStanding,
  blockMenuItems,
  hasReviewStanding,
  tableTargets,
  turnIntoTargets,
  type BlockActionItem,
  type BlockCommandItem,
  type BlockMenuItem,
  type BlockSubmenuItem,
} from './block-menu'
import { tableOpItems } from './menu-items'

const BOTH_STEPS: readonly ReviewStep[] = ['agent', 'peer']

/** The labels of a group, for asserting an offer rather than a shape. */
const labels = (items: BlockMenuItem[]) => items.map(item => item.label)

function itemNamed(groups: BlockMenuItem[][], label: string): BlockMenuItem {
  const found = groups.flat().find(item => item.label === label)
  if (!found) throw new Error(`no menu item labelled "${label}" in ${JSON.stringify(groups.flat().map(i => i.label))}`)
  return found
}

/**
 * The two sentences a refused control says no with — `PageBlocks::refusalReason()`'s
 * own, pinned as words because a reader acts on the sentence.
 */
const FOUR_EYES = 'This block needs a second pair of eyes: its only contributor is the account approving it.'
const UNATTRIBUTED = 'This block needs an identified edit before anybody can sign it off: nothing on record says who wrote it.'

describe('turnIntoTargets', () => {
  it('offers every other shape to a paragraph', () => {
    expect(labels(turnIntoTargets({ pos: 4, type: 'paragraph' }))).toEqual([
      'Heading 1', 'Heading 2', 'Heading 3',
      'Bullet list', 'Ordered list', 'Task list',
      'Quote', 'Code block',
    ])
  })

  it('offers a heading the other levels but not its own', () => {
    const offered = labels(turnIntoTargets({ pos: 0, type: 'heading', level: 2 }))
    expect(offered).toContain('Heading 1')
    expect(offered).toContain('Heading 3')
    expect(offered).not.toContain('Heading 2')
    expect(offered).toContain('Text')
  })

  it('offers a list the other list kinds but not its own', () => {
    const offered = labels(turnIntoTargets({ pos: 0, type: 'bulletList' }))
    expect(offered).not.toContain('Bullet list')
    expect(offered).toContain('Ordered list')
    expect(offered).toContain('Task list')
  })

  // A block type outside the catalogue (a table, an image) still gets the
  // whole offer — which of them the schema allows is `editor.can()`'s answer,
  // applied downstream, not this list's.
  it('offers the whole catalogue to a block that is not in it', () => {
    expect(turnIntoTargets({ pos: 0, type: 'table' })).toHaveLength(9)
  })

  // One handler, addressed by position: the upstream heading/list handlers act
  // on the selection, and the menu opens with the block node-selected.
  it('routes every target through the pos-addressed turnInto handler', () => {
    const targets = turnIntoTargets({ pos: 12, type: 'paragraph' })
    for (const target of targets) {
      expect(target.kind).toBe('turnInto')
      expect(target.pos).toBe(12)
    }
    expect(targets.find(t => t.label === 'Heading 3')).toMatchObject({ target: 'heading', level: 3 })
    expect(targets.find(t => t.label === 'Quote')).toMatchObject({ target: 'blockquote' })
  })
})

describe('approvalStanding', () => {
  /** Ada wrote uid 3's half, Grace uid 7's; neither may moderate. */
  const ADA = { uid: 3, isAdmin: false }
  const GRACE = { uid: 7, isAdmin: false }
  const NOBODY = { uid: null, isAdmin: false }
  /** The ADR 0002 exception, as the client sees it. */
  const MODERATOR = { uid: 3, isAdmin: true }

  const pendingPeer = (by: number[]): PageBlock => ({
    contributors: [
      { uid: 3, via: null, name: 'Ada', lastEdit: 1 },
      { uid: 7, via: null, name: 'Grace', lastEdit: 2 },
    ],
    'pending:peer': { by, ok: [] },
  })

  // Drupal skips a sign-off on a block that is not pending, so one on
  // with neither a flag nor a sign-off would write nothing.
  it('hasReviewStanding is false for a block with neither a flag nor a sign-off', () => {
    const standing = approvalStanding(undefined, BOTH_STEPS, ADA)
    expect(standing).toMatchObject({ state: 'none', refusal: null })
    expect(hasReviewStanding(standing)).toBe(false)
  })

  it('hasReviewStanding is true for a pending enforced step and for a recorded sign-off', () => {
    expect(hasReviewStanding(approvalStanding(pendingPeer([3]), BOTH_STEPS, ADA))).toBe(true)
    const signed: PageBlock = { contributors: [], 'review:peer': { uid: 9, name: 'Grace', at: 1, vid: 2 } }
    expect(hasReviewStanding(approvalStanding(signed, BOTH_STEPS, ADA))).toBe(true)
  })

  // A wiki space enforces no peer step, so the flag every edit stamps leaves
  // nothing to act on.
  it('hasReviewStanding is false for a flag the space does not enforce', () => {
    expect(hasReviewStanding(approvalStanding(pendingPeer([3]), ['agent'], GRACE))).toBe(false)
  })

  it('names the reviewer on a signed-off block, and offers nothing more', () => {
    const block: PageBlock = { contributors: [], 'review:peer': { uid: 9, name: 'Grace', at: 1, vid: 2 } }
    expect(approvalStanding(block, BOTH_STEPS, ADA)).toMatchObject({
      state: 'reviewed',
      label: 'Reviewed by Grace',
      refusal: null,
    })
  })

  it('refuses the sole author of the change', () => {
    expect(approvalStanding(pendingPeer([3]), BOTH_STEPS, ADA)).toMatchObject({
      state: 'awaiting',
      refusal: FOUR_EYES,
    })
  })

  // A flag the collab server mirrored ahead of its checkpoint offers the item
  // like any other, and withholds it from its own writer like any other.
  it('offers the item on a mirrored estimate, by the same rule', () => {
    const estimate: PageBlock = { ...pendingPeer([3]), 'pending:peer': { by: [3], ok: [], estimated: true } }

    expect(approvalStanding(estimate, BOTH_STEPS, GRACE)).toMatchObject({
      state: 'awaiting',
      label: 'Mark reviewed',
      refusal: null,
    })
    expect(approvalStanding(estimate, BOTH_STEPS, ADA)).toMatchObject({ refusal: FOUR_EYES })
  })

  it('lets a co-author sign off work somebody else also wrote', () => {
    expect(approvalStanding(pendingPeer([3, 7]), BOTH_STEPS, ADA)).toMatchObject({
      state: 'awaiting',
      refusal: null,
    })
  })

  it('lets an account who wrote none of it sign off', () => {
    expect(approvalStanding(pendingPeer([3]), BOTH_STEPS, GRACE)).toMatchObject({ refusal: null })
  })

  // The state stampSession() produces for a change no server could attribute:
  // "whoever wrote this may not sign it off" cannot be applied to an episode
  // that does not say who wrote it, so nobody but an admin clears it.
  it('refuses everybody on an episode naming nobody', () => {
    expect(approvalStanding(pendingPeer([]), BOTH_STEPS, ADA)).toMatchObject({ refusal: UNATTRIBUTED })
  })

  it('refuses a session with no account behind it', () => {
    expect(approvalStanding(pendingPeer([7]), BOTH_STEPS, NOBODY)).toMatchObject({ refusal: FOUR_EYES })
  })

  // The agent step asks for a human, not for a second one — so the writer of
  // the block clears it themselves.
  it('lets any account clear the agent step, its own writer included', () => {
    const block: PageBlock = { contributors: [], 'pending:agent': { by: [3], ok: [] } }
    expect(approvalStanding(block, BOTH_STEPS, ADA)).toMatchObject({
      label: 'Sign off the agent write',
      refusal: null,
    })
  })

  // Same filter the gutter marks and the drawer queue apply: a step the space
  // does not enforce holds nothing up, so it must not read as a blocker here.
  it('ignores a pending step the space does not enforce', () => {
    expect(approvalStanding(pendingPeer([3]), ['agent'], ADA)).toMatchObject({ state: 'none' })
  })

  // ADR 0002: an account that may moderate clears anything — its own writing,
  // and an episode naming nobody. The review is still recorded, never skipped.
  it('lets a moderator sign off their own writing', () => {
    expect(approvalStanding(pendingPeer([3]), BOTH_STEPS, MODERATOR)).toMatchObject({
      state: 'awaiting',
      refusal: null,
    })
  })

  it('lets a moderator clear an episode naming nobody', () => {
    expect(approvalStanding(pendingPeer([]), BOTH_STEPS, MODERATOR)).toMatchObject({ refusal: null })
  })

  // The exception is about the account, not about the session existing.
  it('does not let an admin flag stand in for an account', () => {
    expect(approvalStanding(pendingPeer([3]), BOTH_STEPS, { uid: null, isAdmin: true }))
      .toMatchObject({ refusal: FOUR_EYES })
  })

  // The step a control sends. Drupal weighs the sign-off against the step it
  // names, and refuses a peer one on a block owing the agent step.
  it('names the step the block is pending on', () => {
    const agentWrite: PageBlock = { contributors: [], 'pending:agent': { by: [3], ok: [] } }
    expect(approvalStanding(agentWrite, ['agent'], ADA).step).toBe('agent')
    expect(approvalStanding(pendingPeer([3]), BOTH_STEPS, ADA).step).toBe('peer')
  })

  // One sign-off clears one step, and it is the one the margin's leading pill
  // offers — both read REVIEW_STEPS order, not the policy's.
  it('leads with the agent step on a block owing both, whatever order the policy lists', () => {
    const both: PageBlock = {
      contributors: [{ uid: 3, via: null, name: 'Ada', lastEdit: 1 }],
      'pending:peer': { by: [3], ok: [] },
      'pending:agent': { by: [3], ok: [] },
    }
    expect(approvalStanding(both, ['peer', 'agent'], ADA)).toMatchObject({
      step: 'agent',
      label: 'Sign off the agent write',
    })
  })

  it('names no step where there is nothing pending to sign off', () => {
    const signed: PageBlock = { contributors: [], 'review:peer': { uid: 9, name: 'Grace', at: 1, vid: 2 } }
    expect(approvalStanding(signed, BOTH_STEPS, ADA).step).toBeUndefined()
    expect(approvalStanding(undefined, BOTH_STEPS, ADA).step).toBeUndefined()
  })
})

describe('tableTargets', () => {
  it('offers the whole-table operations on a table block', () => {
    const targets = tableTargets({ pos: 8, type: 'table' })
    expect(labels(targets)).toEqual(['Add row below', 'Add column right'])
    // The block menu's own Delete already removes the table.
    expect(labels(targets)).not.toContain('Delete table')
    for (const target of targets) {
      expect(target.kind).toBe('tableBlockOp')
      expect(target.pos).toBe(8)
    }
  })

  it('names the TipTap command each item runs', () => {
    expect(tableTargets({ pos: 0, type: 'table' }).map(item => item.op))
      .toEqual(['addRowAfter', 'addColumnAfter'])
  })

  it('takes label and icon from the one table list, so the surfaces cannot drift', () => {
    for (const target of tableTargets({ pos: 0, type: 'table' })) {
      const source = tableOpItems.find(item => item.op === target.op)
      expect({ label: target.label, icon: target.icon })
        .toEqual({ label: source!.label, icon: source!.icon })
    }
  })

  it('offers nothing on any other block', () => {
    expect(tableTargets({ pos: 0, type: 'paragraph' })).toEqual([])
  })
})

describe('blockMenuItems', () => {
  const actions = {
    cut: vi.fn(), copy: vi.fn(), paste: vi.fn(),
    insertBelow: vi.fn(), cite: vi.fn(), review: vi.fn(), comment: vi.fn(),
  }
  const state = {
    block: { pos: 6, type: 'paragraph' },
    meta: undefined,
    steps: BOTH_STEPS,
    reviewer: { uid: 3, isAdmin: false },
    openThreads: 0,
  }

  it('addresses every command item at the block the menu is open on', () => {
    const commands = blockMenuItems(state, actions).flat().filter(item => 'kind' in item) as BlockCommandItem[]
    expect(commands.map(item => item.kind)).toEqual([
      'duplicate', 'moveUp', 'moveDown', 'delete',
    ])
    for (const command of commands) expect(command.pos).toBe(6)
  })

  it('gives a table block its own group, and no other block one', () => {
    const table = { ...state, block: { pos: 8, type: 'table' } }
    const groups = blockMenuItems(table, actions)
    expect(groups.find(group => labels(group).includes('Add row below'))).toBeTruthy()
    expect(labels(blockMenuItems(state, actions).flat())).not.toContain('Add row below')
  })

  it('offers a citation on every block', () => {
    const item = itemNamed(blockMenuItems(state, actions), 'Cite a source') as BlockActionItem
    item.onSelect()
    expect(actions.cite).toHaveBeenCalled()
  })

  it('hangs the turn-into offer off one submenu', () => {
    const turnInto = itemNamed(blockMenuItems(state, actions), 'Turn into') as BlockSubmenuItem
    expect(labels(turnInto.children)).toEqual(labels(turnIntoTargets(state.block)))
  })

  // The reason goes wherever the control is off, this menu included.
  it('greys the review item out where the rule refuses, and says why', () => {
    const meta: PageBlock = {
      contributors: [{ uid: 3, via: null, name: 'Ada', lastEdit: 1 }],
      'pending:peer': { by: [3], ok: [] },
    }
    const item = itemNamed(blockMenuItems({ ...state, meta }, actions), 'Mark reviewed') as BlockActionItem
    expect(item.disabled).toBe(true)
    expect(item.description).toBe(FOUR_EYES)
  })

  it('offers the same block to a moderator', () => {
    const meta: PageBlock = {
      contributors: [{ uid: 3, via: null, name: 'Ada', lastEdit: 1 }],
      'pending:peer': { by: [3], ok: [] },
    }
    const menu = blockMenuItems({ ...state, meta, reviewer: { uid: 3, isAdmin: true } }, actions)
    const item = itemNamed(menu, 'Mark reviewed') as BlockActionItem
    expect(item.disabled).toBe(false)
    expect(item.description).toBeUndefined()
  })

  it('blockMenuItems omits the review item when the block has no review standing', () => {
    const shown = labels(blockMenuItems(state, actions).flat())
    expect(shown).not.toContain('Mark reviewed')
    // The comment item is not review chrome: any block can be talked about.
    expect(shown).toContain('Comment')
  })

  it('counts the open threads into the comment item', () => {
    expect(itemNamed(blockMenuItems(state, actions), 'Comment')).toBeTruthy()
    expect(itemNamed(blockMenuItems({ ...state, openThreads: 2 }, actions), 'Comments (2)')).toBeTruthy()
  })

  it('runs the session action the item was built with', () => {
    const item = itemNamed(blockMenuItems(state, actions), 'Copy') as BlockActionItem
    item.onSelect()
    expect(actions.copy).toHaveBeenCalled()
  })

  // Cut, copy and paste are the session's own — the clipboard is asynchronous
  // and a paste has to parse markdown back into nodes, so none of the three
  // can be a `kind` the synchronous editor handlers execute.
  it('keeps the clipboard trio together, each on its own action', () => {
    const groups = blockMenuItems(state, actions)
    const clipboard = groups.find(group => labels(group).includes('Cut'))!
    expect(labels(clipboard)).toEqual(['Cut', 'Copy', 'Paste below'])
    for (const [label, action] of [['Cut', actions.cut], ['Paste below', actions.paste]] as const) {
      (itemNamed(groups, label) as BlockActionItem).onSelect()
      expect(action).toHaveBeenCalled()
    }
  })

  // The upstream `suggestion` handler drops the "/" in as part of a node, and
  // the suggestion plugin never goes active off that — the session types it
  // into a focused editor instead, once the menu is out of the way.
  it('runs Insert below through the session rather than an editor handler', () => {
    const item = itemNamed(blockMenuItems(state, actions), 'Insert below…') as BlockActionItem
    expect('kind' in item).toBe(false)
    item.onSelect()
    expect(actions.insertBelow).toHaveBeenCalled()
  })

  // Delete sits alone in the last group, where a mis-click is least likely to
  // land on it.
  it('keeps Delete on its own at the end', () => {
    const groups = blockMenuItems(state, actions)
    expect(labels(groups.at(-1)!)).toEqual(['Delete'])
  })
})
