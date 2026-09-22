// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import HorizontalRule from '@tiptap/extension-horizontal-rule'
import { BulletList, ListItem } from '@tiptap/extension-list'
import { AllSelection, EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { DecorationSet } from '@tiptap/pm/view'
import { editorSchema } from '../../server/utils/editor-schema'
import type { PageBlock, BlockMetaMap, ReviewStep } from '#shared/page-blocks'
import { mayApprove } from '#shared/page-blocks'
import {
  activeBlockDecoration,
  addressableBlocks,
  approveActionLabel,
  createActiveBlockPlugin,
  blockAtSelection,
  createReviewMarksPlugin,
  reviewableCount,
  reviewDecorations,
  reviewMarkOf,
  reviewMarksKey,
  reviewQueue,
  reviewToggleLabel,
  ReviewMarks,
  signOffRefusal,
  reviewPills,
  sidecarLookup,
  stepMarkLabel,
  topLevelBlockPos,
  unidentifiedBlocks,
  type ReviewLookup,
  type WaitingState,
} from './review-marks'

function para(text: string, id: string | null): PMNode {
  return editorSchema.node('paragraph', { id }, text ? [editorSchema.text(text)] : [])
}
function bullets(...items: string[]): PMNode {
  return editorSchema.node('bulletList', null, items.map(text =>
    editorSchema.node('listItem', null, [editorSchema.node('paragraph', null, [editorSchema.text(text)])]),
  ))
}
function doc(...blocks: PMNode[]): PMNode {
  return editorSchema.node('doc', null, blocks)
}

/** A block Drupal signed off. */
function signedOff(name?: string | null): PageBlock {
  return { contributors: [], 'review:peer': { uid: 3, name, at: 1000, vid: 7 } }
}

/** A block Drupal flagged as owing a peer review, waiting on `by`. */
function awaiting(by: number[] = [3]): PageBlock {
  return { contributors: [], 'pending:peer': { by, ok: [] } }
}

/** The same flag, mirrored by the collab server ahead of its checkpoint. */
function estimated(by: number[] = [3]): PageBlock {
  return { contributors: [], 'pending:peer': { by, ok: [], estimated: true } }
}

/** A block owing the agent step — a human has to read what a machine wrote. */
function awaitingAgent(by: number[] = [3]): PageBlock {
  return { contributors: [], 'pending:agent': { by, ok: [] } }
}

/** A block owing both steps: an agent wrote it, so a peer still owes a look. */
function awaitingBoth(by: number[] = [3]): PageBlock {
  return { contributors: [], 'pending:peer': { by, ok: [] }, 'pending:agent': { by, ok: [] } }
}

/**
 * The two sentences the control says no with, pinned here as words: they are
 * `PageBlocks::refusalReason()`'s own, and a reader acts on the sentence.
 */
const REFUSAL: Record<WaitingState, string | null> = {
  'reviewable': null,
  'awaiting-others': 'This block needs a second pair of eyes: its only contributor is the account approving it.',
  'unattributed': 'This block needs an identified edit before anybody can sign it off: nothing on record says who wrote it.',
}

/** The mark a set of owed steps produces — the shape every case below asserts. */
function owes(...steps: Array<[ReviewStep, WaitingState]>) {
  return {
    state: steps[0]![1],
    steps: steps.map(([step, state]) => ({ step, state, refusal: REFUSAL[state] })),
  }
}

/** The checkmark a pending pill carries, as every case below asserts it. */
function approves(step: ReviewStep, state: WaitingState) {
  return { step, label: approveActionLabel(step), refusal: REFUSAL[state] }
}

/** The accounts the fixtures speak of: 3 wrote, 7 did not, 9 may moderate. */
const WRITER = { uid: 3, isAdmin: false }
const OTHER = { uid: 7, isAdmin: false }
const MODERATOR = { uid: 9, isAdmin: true }
const NOBODY = { uid: null, isAdmin: false }

/** Decoration specs in document order, for asserting the projection. */
function specs(doc: PMNode, lookup: ReviewLookup): Array<Record<string, unknown>> {
  return reviewDecorations(doc, lookup)
    .find()
    .map(d => (d as unknown as { type: { attrs?: Record<string, unknown> } }).type.attrs)
    .filter((attrs): attrs is Record<string, unknown> => !!attrs)
}

/** The pills each marked block's widget draws, in document order. */
function drawnPills(doc: PMNode, lookup: ReviewLookup): Array<Array<[string, string]>> {
  return reviewDecorations(doc, lookup)
    .find()
    .map(d => (d as unknown as { spec?: { pills?: Array<{ tone: string, label: string }> } }).spec?.pills)
    .filter(pills => !!pills)
    .map(pills => pills.map(pill => [pill.tone, pill.label] as [string, string]))
}

describe('addressableBlocks', () => {
  it('lists the top-level id-bearing blocks with their text', () => {
    const d = doc(para('first', 'b-1'), para('second', 'b-2'))
    expect(addressableBlocks(d).map(b => [b.id, b.text])).toEqual([['b-1', 'first'], ['b-2', 'second']])
  })

  it('reports an id-less block with a null id rather than skipping it', () => {
    const d = doc(para('no id yet', null))
    expect(addressableBlocks(d).map(b => b.id)).toEqual([null])
  })

  it('includes container blocks — their id rides the ::block wrapper fence', () => {
    const d = doc(para('a', 'b-1'), bullets('x', 'y'))
    expect(addressableBlocks(d).map(b => b.id)).toEqual(['b-1', null])
  })
})

describe('unidentifiedBlocks', () => {
  it('names the id-less blocks that carry something', () => {
    const d = doc(para('has one', 'b-1'), para('has none', null), bullets('x'))
    expect(unidentifiedBlocks(d).map(b => b.text)).toEqual(['has none', 'x'])
  })

  it('ignores an empty paragraph — it serializes to nothing, so it holds nothing', () => {
    // Drupal's segmentation drops empty chunks, and this has to agree with it
    // or the trailing blank line every document ends on would read as a hold.
    expect(unidentifiedBlocks(doc(para('kept', 'b-1'), para('', null)))).toEqual([])
  })
})

describe('blockAtSelection', () => {
  function stateWithCursorIn(blocks: PMNode[], index: number): EditorState {
    const d = doc(...blocks)
    let pos = 0
    for (let i = 0; i < index; i++) pos += d.child(i).nodeSize
    return EditorState.create({
      schema: editorSchema,
      doc: d,
      // `near` searching forward lands inside the block's own inline content
      // for a paragraph, and inside the first list item for a bulletList —
      // a real cursor position in both, which `create` is not for a container.
      selection: TextSelection.near(d.resolve(pos + 1), 1),
    })
  }

  it('finds the id-bearing block holding the cursor', () => {
    const state = stateWithCursorIn([para('first', 'b-1'), para('second', 'b-2')], 1)
    expect(blockAtSelection(state)).toMatchObject({ id: 'b-2', text: 'second' })
  })

  it('resolves the container block itself for a cursor inside it', () => {
    const state = stateWithCursorIn([para('a', 'b-1'), bullets('x')], 1)
    expect(blockAtSelection(state)).toMatchObject({ id: null })
  })

  // What the drag handle sets when its block menu opens: a NodeSelection on a
  // top-level block, whose head resolves to depth 0 and names no textblock.
  it('resolves a top-level NodeSelection as the block it selects', () => {
    const d = doc(para('first', 'b-1'), para('second', 'b-2'))
    const state = EditorState.create({
      schema: editorSchema,
      doc: d,
      selection: NodeSelection.create(d, d.child(0).nodeSize),
    })
    expect(blockAtSelection(state)).toMatchObject({ id: 'b-2', text: 'second' })
  })

  // Select-all names the document, not a block — what the block menu falls
  // back on when it has nothing to act on.
  it('names no block for a selection over the whole document', () => {
    const d = doc(para('first', 'b-1'), para('second', 'b-2'))
    const state = EditorState.create({ schema: editorSchema, doc: d, selection: new AllSelection(d) })
    expect(topLevelBlockPos(state)).toBeNull()
    expect(blockAtSelection(state)).toBeNull()
  })
})

/**
 * The rule the whole affordance rests on (OKB-190).
 *
 * `reviewMarkOf` is the client's reading of
 * `\Drupal\openkb_workflow\PageBlocks::mayApprove()` as a question about
 * the account in front of the block: may I clear this, or is it waiting on
 * somebody else? These cases are that rule, pinned — four states, both steps,
 * and the admin exception — so a projection that drifts from Drupal's answer
 * fails here rather than as a refusal after the round trip.
 */
describe('reviewMarkOf', () => {
  it('says nothing about a block the sidecar does not mention', () => {
    expect(reviewMarkOf(undefined, undefined, OTHER)).toBeNull()
    expect(reviewMarkOf({ contributors: [] }, undefined, OTHER)).toBeNull()
  })

  // --- The peer step: four eyes ------------------------------------------

  it('offers the block to an account that wrote none of it', () => {
    expect(reviewMarkOf(awaiting([3]), ['peer'], OTHER)).toEqual(owes(['peer', 'reviewable']))
  })

  it('offers it to a co-author — somebody else wrote part of it too', () => {
    expect(reviewMarkOf(awaiting([3, 7]), ['peer'], WRITER)).toEqual(owes(['peer', 'reviewable']))
  })

  // What fago asked to see: my own writing is not mine to sign off.
  it('tells the sole author of the change that it needs other eyes', () => {
    expect(reviewMarkOf(awaiting([3]), ['peer'], WRITER)).toEqual(owes(['peer', 'awaiting-others']))
  })

  // The state stampSession() produces for a change no server could attribute.
  // "Whoever wrote this may not sign it off" cannot be applied to an episode
  // that does not say who wrote it, so nobody but an admin clears it — and an
  // identified edit is what unblocks it.
  it('marks an episode naming nobody as unattributed, for its own carrier too', () => {
    expect(reviewMarkOf(awaiting([]), ['peer'], WRITER)).toEqual(owes(['peer', 'unattributed']))
    expect(reviewMarkOf(awaiting([]), ['peer'], OTHER)).toEqual(owes(['peer', 'unattributed']))
  })

  it('offers nothing to a session with no account behind it', () => {
    expect(reviewMarkOf(awaiting([3]), ['peer'], NOBODY)).toEqual(owes(['peer', 'awaiting-others']))
    expect(reviewMarkOf(awaiting([]), ['peer'], NOBODY)).toEqual(owes(['peer', 'unattributed']))
  })

  // The mirrored estimate reads exactly as the flag it will become: the peer it
  // is drawn for is offered it, and its writer still owes other eyes. A pill
  // that changed words at the checkpoint would be worse than a slow one.
  it('reads a mirrored estimate as the flag it will become', () => {
    expect(reviewMarkOf(estimated([3]), ['peer'], OTHER)).toEqual(owes(['peer', 'reviewable']))
    expect(reviewMarkOf(estimated([3]), ['peer'], WRITER)).toEqual(owes(['peer', 'awaiting-others']))
    expect(reviewMarkOf(estimated([]), ['peer'], OTHER)).toEqual(owes(['peer', 'unattributed']))
  })

  it('labels a mirrored estimate the reader\'s own move, and offers the sign-off on it', () => {
    const mark = reviewMarkOf(estimated([3]), ['peer'], OTHER)!
    expect(reviewPills(mark)).toEqual([{
      tone: 'reviewable',
      label: 'Pending peer review',
      approve: approves('peer', 'reviewable'),
    }])
  })

  // --- The agent step: a human, not a second one -------------------------

  it('offers an agent-step block to anybody, its own writer included', () => {
    expect(reviewMarkOf(awaitingAgent([3]), ['agent'], WRITER)).toEqual(owes(['agent', 'reviewable']))
    expect(reviewMarkOf(awaitingAgent([3]), ['agent'], OTHER)).toEqual(owes(['agent', 'reviewable']))
  })

  it('still refuses an agent-step block to a session with no account', () => {
    expect(reviewMarkOf(awaitingAgent([3]), ['agent'], NOBODY)).toEqual(owes(['agent', 'awaiting-others']))
  })

  // One approvable step is enough to make the block worth going to, whatever
  // the other one is waiting on.
  it('reads as reviewable when any enforced pending step is', () => {
    const block = awaitingBoth([3])
    expect(reviewMarkOf(block, ['peer', 'agent'], WRITER))
      .toEqual(owes(['agent', 'reviewable'], ['peer', 'awaiting-others']))
    expect(reviewMarkOf(block, ['peer'], WRITER)).toEqual(owes(['peer', 'awaiting-others']))
  })

  // --- The admin exception (ADR 0002) ------------------------------------

  it('offers a moderator anything pending, their own writing included', () => {
    expect(reviewMarkOf(awaiting([9]), ['peer'], MODERATOR)).toEqual(owes(['peer', 'reviewable']))
    expect(reviewMarkOf(awaiting([]), ['peer'], MODERATOR)).toEqual(owes(['peer', 'reviewable']))
  })

  it('does not let the admin flag stand in for an account', () => {
    expect(reviewMarkOf(awaiting([]), ['peer'], { uid: null, isAdmin: true }))
      .toEqual(owes(['peer', 'unattributed']))
  })

  // --- The policy filter, and completed sign-offs ------------------------

  // The wiki-space case: every edit stamps `pending:peer`, the space only ever
  // asks for `agent`, and the drawer's queue is empty. A chip here would send
  // an editor looking for work nothing is waiting on.
  it('says nothing about a step the space does not enforce', () => {
    expect(reviewMarkOf(awaiting(), ['agent'], OTHER)).toBeNull()
  })

  it('still reports a sign-off given on an unenforced step', () => {
    expect(reviewMarkOf(signedOff('fago'), ['agent'], OTHER))
      .toEqual({ state: 'reviewed', steps: [], name: 'fago' })
  })

  it('lets an enforced pending step outrank a completed one', () => {
    const block: PageBlock = { ...signedOff('fago'), ...awaitingAgent([3]) }
    expect(reviewMarkOf(block, ['agent'], WRITER)).toEqual(owes(['agent', 'reviewable']))
    expect(reviewMarkOf(block, ['peer'], WRITER)).toEqual({ state: 'reviewed', steps: [], name: 'fago' })
  })

  // A recorded sign-off is a fact about the block, not a question about who is
  // reading it.
  it('reads a signed-off block the same way for everybody', () => {
    for (const reviewer of [WRITER, OTHER, MODERATOR, NOBODY]) {
      expect(reviewMarkOf(signedOff('fago'), ['peer'], reviewer))
        .toEqual({ state: 'reviewed', steps: [], name: 'fago' })
    }
  })

  it('enforces both steps when handed no policy', () => {
    expect(reviewMarkOf(awaiting([3]), undefined, OTHER)).toEqual(owes(['peer', 'reviewable']))
  })

  // --- Both steps, agent first -------------------------------------------

  /**
   * What fago asked for: "if a step needs both, show both. primary is the
   * agent approval. secondary, next item is the peer approval." The order is
   * the review order — a human reads what the agent wrote, and the block then
   * stands as that human's writing, still owing an independent peer.
   */
  it('reports both owed steps, agent first, whatever order the policy names them in', () => {
    for (const policy of [['agent', 'peer'], ['peer', 'agent']] as ReviewStep[][]) {
      expect(reviewMarkOf(awaitingBoth([3]), policy, OTHER))
        .toEqual(owes(['agent', 'reviewable'], ['peer', 'reviewable']))
    }
  })

  /** Each step answers for itself: the agent step is anybody's to clear, the
   *  peer step is not its own writer's. */
  it('states each owed step separately for the account that wrote the block', () => {
    expect(reviewMarkOf(awaitingBoth([3]), undefined, WRITER))
      .toEqual(owes(['agent', 'reviewable'], ['peer', 'awaiting-others']))
    expect(reviewMarkOf(awaitingBoth([]), undefined, NOBODY))
      .toEqual(owes(['agent', 'unattributed'], ['peer', 'unattributed']))
  })

  it('leads with the peer step where the space asks for that one alone', () => {
    expect(reviewMarkOf(awaitingBoth([3]), ['peer'], OTHER)).toEqual(owes(['peer', 'reviewable']))
    expect(reviewMarkOf(awaitingBoth([3]), ['agent'], OTHER)).toEqual(owes(['agent', 'reviewable']))
  })
})

describe('reviewPills', () => {
  it('names the reviewer when the record captured one', () => {
    expect(reviewPills({ state: 'reviewed', steps: [], name: 'fago' }))
      .toEqual([{ tone: 'reviewed', label: 'Reviewed by fago' }])
  })

  it('degrades to an unnamed label', () => {
    expect(reviewPills({ state: 'reviewed', steps: [], name: null }))
      .toEqual([{ tone: 'reviewed', label: 'Reviewed' }])
  })

  // The waiting labels have to differ: one label for all of them is the state
  // this ticket exists to end, where a reader finds out a block is not theirs
  // by being refused. "Pending" is the reader's own move, "Waiting for"
  // somebody else's, and each names the review that is owed rather than a
  // person who is not there.
  it('says which review is owed, and whose move it is', () => {
    expect(reviewPills(owes(['peer', 'reviewable']))).toEqual([
      { tone: 'reviewable', label: 'Pending peer review', approve: approves('peer', 'reviewable') },
    ])
    expect(reviewPills(owes(['peer', 'awaiting-others']))).toEqual([
      { tone: 'awaiting-others', label: 'Waiting for peer review', approve: approves('peer', 'awaiting-others') },
    ])
    expect(reviewPills(owes(['peer', 'unattributed']))).toEqual([
      { tone: 'unattributed', label: 'Pending admin review', approve: approves('peer', 'unattributed') },
    ])
  })

  it('names nobody on a block that is still waiting', () => {
    expect(reviewPills({ ...owes(['peer', 'awaiting-others']), name: 'fago' }))
      .toEqual([{
        tone: 'awaiting-others',
        label: 'Waiting for peer review',
        approve: approves('peer', 'awaiting-others'),
      }])
  })

  /**
   * The constraint the palette must not spend: violet and blue are a
   * distinction a fair number of readers cannot see, so the words carry it.
   * The agent step is anybody's to clear, so it reads the same in every state.
   */
  it('names the agent step in words, never in colour alone', () => {
    expect(reviewPills(owes(['agent', 'reviewable']))).toEqual([
      { tone: 'agent', label: 'Pending agent review', approve: approves('agent', 'reviewable') },
    ])
    expect(reviewPills(owes(['agent', 'unattributed']))).toEqual([
      { tone: 'agent', label: 'Pending agent review', approve: approves('agent', 'unattributed') },
    ])
    expect(stepMarkLabel({ step: 'agent', state: 'reviewable' }))
      .not.toBe(stepMarkLabel({ step: 'peer', state: 'reviewable' }))
  })

  /**
   * Two approvals by two people are two pills, in two colours — one sentence
   * saying both would read as a single verdict.
   */
  it('draws a block owing both steps as two pills, the agent approval first', () => {
    expect(reviewPills(owes(['agent', 'reviewable'], ['peer', 'awaiting-others']))).toEqual([
      { tone: 'agent', label: 'Pending agent review', approve: approves('agent', 'reviewable') },
      { tone: 'awaiting-others', label: 'Waiting for peer review', approve: approves('peer', 'awaiting-others') },
    ])
  })

  it('labels one step the same whether it stands alone or beside the other', () => {
    const step = { step: 'peer' as const, state: 'reviewable' as const }
    expect(stepMarkLabel(step)).toBe('Pending peer review')
    expect(reviewPills(owes(['agent', 'reviewable'], ['peer', 'reviewable']))[1])
      .toEqual({ tone: 'reviewable', label: stepMarkLabel(step), approve: approves('peer', 'reviewable') })
  })
})

describe('signOffRefusal', () => {
  /**
   * Each sentence says what would unblock the block, which is the difference
   * the reader acts on: find a colleague, or make an identified edit.
   */
  it('names the four-eyes rule where the reader is the only contributor', () => {
    expect(signOffRefusal(awaiting([3]), 'peer', WRITER)).toBe(REFUSAL['awaiting-others'])
    expect(signOffRefusal(awaiting([3]), 'peer', OTHER)).toBeNull()
  })

  it('asks for an identified edit where nobody is on record', () => {
    expect(signOffRefusal(awaiting([]), 'peer', WRITER)).toBe(REFUSAL['unattributed'])
    expect(signOffRefusal(awaiting([]), 'peer', OTHER)).toBe(REFUSAL['unattributed'])
  })

  // ADR 0002: an account that may moderate clears anything, its own writing
  // and a block naming nobody included.
  it('refuses a moderator nothing', () => {
    expect(signOffRefusal(awaiting([9]), 'peer', MODERATOR)).toBeNull()
    expect(signOffRefusal(awaiting([]), 'peer', MODERATOR)).toBeNull()
  })

  // The agent step asks for a human, not a second one.
  it('refuses nobody the agent step', () => {
    for (const reviewer of [WRITER, OTHER, MODERATOR]) {
      expect(signOffRefusal(awaitingAgent([3]), 'agent', reviewer)).toBeNull()
      expect(signOffRefusal(awaitingAgent([]), 'agent', reviewer)).toBeNull()
    }
  })

  /** One rule, two readings: the sentence and the state cannot disagree. */
  it('says no exactly where Drupal\u2019s rule does', () => {
    const blocks = [awaiting([3]), awaiting([]), awaitingAgent([3]), awaitingBoth([3])]
    for (const block of blocks) {
      for (const step of ['peer', 'agent'] as const) {
        for (const reviewer of [WRITER, OTHER, MODERATOR]) {
          expect(signOffRefusal(block, step, reviewer) === null, `${step} for uid ${reviewer.uid}`)
            .toBe(mayApprove(block, step, reviewer))
        }
      }
    }
  })
})

describe('reviewDecorations', () => {
  it('decorates only the blocks the sidecar says something about', () => {
    const map: BlockMetaMap = { 'b-1': signedOff('fago'), 'b-2': { contributors: [] } }
    const d = doc(para('first', 'b-1'), para('second', 'b-2'))
    expect(specs(d, sidecarLookup(map, undefined, OTHER))).toEqual([
      { 'class': 'okb-review okb-review--reviewed' },
    ])
  })

  it('renders a flagged block as waiting, whatever it was signed off as before', () => {
    const map: BlockMetaMap = { 'b-1': { ...signedOff('fago'), ...awaiting([3]) } }
    const d = doc(para('rewritten', 'b-1'))
    expect(specs(d, sidecarLookup(map, undefined, OTHER)))
      .toEqual([{ 'class': 'okb-review okb-review--reviewable okb-review--peer' }])
  })

  // The same block, the same sidecar, two readers — the class and the label
  // are what tell them apart, and CSS draws each in its own colour.
  it('draws one block differently for the account that wrote it', () => {
    const map: BlockMetaMap = { 'b-1': awaiting([3]) }
    const d = doc(para('mine', 'b-1'))
    expect(specs(d, sidecarLookup(map, undefined, WRITER)))
      .toEqual([{ 'class': 'okb-review okb-review--awaiting-others okb-review--peer' }])
    expect(drawnPills(d, sidecarLookup(map, undefined, WRITER)))
      .toEqual([[['awaiting-others', 'Waiting for peer review']]])
    expect(specs(d, sidecarLookup(map, undefined, MODERATOR)))
      .toEqual([{ 'class': 'okb-review okb-review--reviewable okb-review--peer' }])
    expect(drawnPills(d, sidecarLookup(map, undefined, MODERATOR)))
      .toEqual([[['reviewable', 'Pending peer review']]])
  })

  it('draws an episode naming nobody as its own state', () => {
    const map: BlockMetaMap = { 'b-1': awaiting([]) }
    expect(specs(doc(para('orphaned', 'b-1')), sidecarLookup(map, undefined, OTHER)))
      .toEqual([{ 'class': 'okb-review okb-review--unattributed okb-review--peer' }])
    expect(drawnPills(doc(para('orphaned', 'b-1')), sidecarLookup(map, undefined, OTHER)))
      .toEqual([[['unattributed', 'Pending admin review']]])
  })

  /**
   * The distinction the gutter exists to draw (OKB-195): a block waiting on a
   * peer and one waiting on a human to read what an agent wrote are two
   * different jobs, and until the step reaches the class list they render
   * identically.
   */
  it('draws the agent step apart from the peer step', () => {
    const map: BlockMetaMap = { 'b-1': awaiting([3]), 'b-2': awaitingAgent([3]) }
    const d = doc(para('a peer wrote this', 'b-1'), para('an agent wrote this', 'b-2'))
    const [peerBlock, agentBlock] = specs(d, sidecarLookup(map, undefined, OTHER))
    expect(peerBlock).toEqual({ 'class': 'okb-review okb-review--reviewable okb-review--peer' })
    expect(agentBlock).toEqual({ 'class': 'okb-review okb-review--reviewable okb-review--agent' })
    expect(drawnPills(d, sidecarLookup(map, undefined, OTHER))).toEqual([
      [['reviewable', 'Pending peer review']],
      [['agent', 'Pending agent review']],
    ])
  })

  /**
   * Two pills rather than one joined label: two approvals by two people, each
   * in its own colour. The block carries both step classes, so the left rule
   * takes the agent's — the first pill's — colour.
   */
  it('draws a block owing both steps as two pills, the agent step first', () => {
    const map: BlockMetaMap = { 'b-1': awaitingBoth([3]) }
    const d = doc(para('an agent wrote this too', 'b-1'))
    expect(specs(d, sidecarLookup(map, undefined, WRITER)))
      .toEqual([{ 'class': 'okb-review okb-review--reviewable okb-review--agent okb-review--peer' }])
    expect(drawnPills(d, sidecarLookup(map, undefined, WRITER))).toEqual([[
      ['agent', 'Pending agent review'],
      ['awaiting-others', 'Waiting for peer review'],
    ]])
  })

  // The widget hangs inside the block it is about, so it moves with it.
  it('anchors the pills inside the block they describe', () => {
    const map: BlockMetaMap = { 'b-2': awaiting() }
    const d = doc(para('first', 'b-1'), para('second', 'b-2'))
    const widget = reviewDecorations(d, sidecarLookup(map, undefined, OTHER))
      .find()
      .find(deco => deco.from === deco.to)
    expect(widget!.from).toBe(d.child(0).nodeSize + 1)
  })

  // A leaf block has no inside, so its pills ride the gap after it.
  it('hangs a leaf block\u2019s pills in the gap after it', () => {
    const rule = editorSchema.node('horizontalRule', { id: 'b-1' })
    const d = doc(rule, para('after', 'b-2'))
    const map: BlockMetaMap = { 'b-1': awaiting() }
    const widget = reviewDecorations(d, sidecarLookup(map, undefined, OTHER))
      .find()
      .find(deco => deco.from === deco.to)
    expect(rule.isLeaf).toBe(true)
    expect(widget!.from).toBe(rule.nodeSize)
  })

  it('draws no chip in a space that does not enforce the pending step', () => {
    const map: BlockMetaMap = { 'b-1': awaiting() }
    const d = doc(para('untouched by any policy', 'b-1'))
    expect(specs(d, sidecarLookup(map, ['peer'], OTHER))).toHaveLength(1)
    expect(specs(d, sidecarLookup(map, ['agent'], OTHER))).toEqual([])
    expect(drawnPills(d, sidecarLookup(map, ['agent'], OTHER))).toEqual([])
  })

  it('anchors the decoration to the reviewed block, not the first one', () => {
    const map: BlockMetaMap = { 'b-2': signedOff(null) }
    const d = doc(para('first', 'b-1'), para('second', 'b-2'))
    const [decoration] = reviewDecorations(d, sidecarLookup(map, undefined, OTHER)).find()
    expect(decoration!.from).toBe(d.child(0).nodeSize)
  })

  it('ignores a sidecar entry whose block is gone', () => {
    const map: BlockMetaMap = { 'b-orphan': signedOff(null) }
    expect(specs(doc(para('here', 'b-1')), sidecarLookup(map, undefined, OTHER))).toEqual([])
  })

  it('skips an id-less block — a review has nothing to key on', () => {
    const map: BlockMetaMap = { 'b-1': signedOff(null) }
    expect(specs(doc(para('text', null)), sidecarLookup(map, undefined, OTHER))).toEqual([])
  })
})

/**
 * The one-click sign-off (OKB-195).
 *
 * A block owing both steps owes two approvals by two people, so the margin
 * offers one control per step and one click names one step. A control the rule
 * would refuse takes no click and says why; the endpoint still answers the
 * sign-offs it does get.
 */
describe('the checkmark', () => {
  /**
   * Refused where {@link mayApprove} says no, and by the same call, so the
   * control's answer and the server's cannot drift.
   */
  it('offers the sign-off exactly where Drupal\u2019s rule says it may be taken', () => {
    const cases = [[awaiting([3]), 'peer'], [awaitingAgent([3]), 'agent']] as const
    for (const [block, step] of cases) {
      for (const reviewer of [WRITER, OTHER, MODERATOR, NOBODY]) {
        const pill = reviewPills(reviewMarkOf(block, [step], reviewer)!)[0]!
        expect(pill.approve!.label).toBe(approveActionLabel(step))
        expect(pill.approve!.refusal === null, `${step} for uid ${reviewer.uid}`)
          .toBe(mayApprove(block, step, reviewer))
      }
    }
  })

  it('offers nothing on the pill that records a sign-off', () => {
    expect(reviewPills({ state: 'reviewed', steps: [], name: 'fago' })[0]!.approve).toBeUndefined()
  })

  /**
   * Both steps, all four states. What the control is called says which step it
   * clears and nothing about who is looking — the state is in the pill it sits
   * on, and in whether the control takes a click.
   */
  it('names the control after the step it clears, in every state', () => {
    const waiting = ['reviewable', 'awaiting-others', 'unattributed'] as const
    for (const state of waiting) {
      expect(reviewPills(owes(['agent', state]))[0]!.approve).toEqual(approves('agent', state))
      expect(reviewPills(owes(['peer', state]))[0]!.approve).toEqual(approves('peer', state))
    }
    expect(approveActionLabel('agent')).not.toBe(approveActionLabel('peer'))
    expect(reviewPills({ state: 'reviewed', steps: [] })).toEqual([{ tone: 'reviewed', label: 'Reviewed' }])
  })

  it('gives a block owing both steps one control per step, the agent\u2019s first', () => {
    const pills = reviewPills(reviewMarkOf(awaitingBoth([3]), undefined, WRITER)!)
    expect(pills.map(pill => pill.approve!.step)).toEqual(['agent', 'peer'])
    // The writer may clear what an agent wrote for them, and may not stand in
    // for the peer their own writing still owes.
    expect(pills.map(pill => pill.approve!.refusal)).toEqual([null, REFUSAL['awaiting-others']])
  })

  // The widget's events are the widget's own: a click must not move the caret
  // or reach the document under it.
  it('keeps its events out of the document', () => {
    const widget = reviewDecorations(doc(para('text', 'b-1')), sidecarLookup({ 'b-1': awaiting() }, undefined, OTHER))
      .find()
      .find(deco => deco.from === deco.to)!
    expect((widget as unknown as { spec: { stopEvent: () => boolean } }).spec.stopEvent()).toBe(true)
  })
})

/**
 * The control as a mounted editor draws it, and what one click asks for.
 *
 * A real view, because everything under test here is what the widget builds:
 * the accessible name, the tab order across blocks, and the position a click
 * resolves back to.
 */
describe('the checkmark, mounted', () => {
  const editors: Editor[] = []
  afterEach(() => { editors.splice(0).forEach(editor => editor.destroy()) })

  /** Paragraphs carry the block id the whole review model keys on. */
  const IdParagraph = Paragraph.extend({
    addAttributes() {
      return { id: { default: null } }
    },
  })

  /** A paragraph carrying `id` — the shape most of these cases need. */
  function paraNode(id: string) {
    return { type: 'paragraph', attrs: { id }, content: [{ type: 'text', text: id }] }
  }

  function mount(map: BlockMetaMap, nodes: object[], reviewer = OTHER) {
    const asked: Array<[string, ReviewStep | undefined]> = []
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        IdParagraph,
        Text,
        // A container and a leaf beside the paragraphs: the three shapes an
        // id-bearing block comes in, and three different selections.
        BulletList.extend({ addAttributes: () => ({ id: { default: null } }) }),
        ListItem,
        HorizontalRule.extend({ addAttributes: () => ({ id: { default: null } }) }),
        ReviewMarks.configure({
          lookup: sidecarLookup(map, undefined, reviewer),
          approve: (id, step) => { asked.push([id, step]) },
        }),
      ],
      content: { type: 'doc', content: nodes },
    })
    editors.push(editor)
    const controls = () => [...editor.view.dom.querySelectorAll<HTMLButtonElement>('.okb-review-approve')]
    return { editor, asked, controls }
  }

  it('draws a real button, named after the action and described by the pill', () => {
    const { editor, controls } = mount({ 'b-1': awaitingAgent([3]) }, [paraNode('b-1')])
    const [button] = controls()
    expect(button!.tagName).toBe('BUTTON')
    expect(button!.getAttribute('type')).toBe('button')
    expect(button!.getAttribute('aria-label')).toBe('Sign off the agent write')
    const pill = editor.view.dom.querySelector(`#${button!.getAttribute('aria-describedby')}`)
    expect(pill!.getAttribute('aria-label')).toBe('Pending agent review')
  })

  /**
   * Beside its pill, not inside it: the pill clips to its own box for the
   * ellipsis, and the control is bigger than the pill on purpose. The pill is
   * still what describes it, by id rather than by nesting.
   */
  it('draws the control beside its pill, still described by it', () => {
    const { editor, controls } = mount({ 'b-1': awaitingAgent([3]) }, [paraNode('b-1')])
    const [button] = controls()
    const pill = editor.view.dom.querySelector(`#${button!.getAttribute('aria-describedby')}`)
    expect(pill!.contains(button!)).toBe(false)
    expect(button!.parentElement).toBe(pill!.parentElement)
    expect(button!.previousElementSibling).toBe(pill)
  })

  // Its pill's colour, which the palette keys on a class rather than on nesting.
  it('carries its pill\u2019s tone', () => {
    const { controls } = mount({ 'b-1': awaitingBoth([3]) }, [paraNode('b-1')], WRITER)
    expect(controls().map(button => button.className)).toEqual([
      'okb-review-approve okb-review-approve--agent',
      'okb-review-approve okb-review-approve--awaiting-others',
    ])
  })

  /**
   * `aria-disabled` rather than `disabled` for two reasons that point the same
   * way: a disabled button draws no tooltip, and it leaves the tab order,
   * taking its own announcement with it.
   */
  it('takes no click where the rule refuses one, and says why', () => {
    const { asked, controls } = mount({ 'b-1': awaiting([7]) }, [paraNode('b-1')], OTHER)
    const [button] = controls()
    expect(button!.getAttribute('aria-disabled')).toBe('true')
    expect(button!.hasAttribute('disabled')).toBe(false)
    expect(button!.title).toBe(REFUSAL['awaiting-others'])
    button!.click()
    expect(asked, 'a refused control asks nothing').toEqual([])
  })

  /**
   * A `title` is dropped wherever `aria-describedby` answers, so the reason
   * has to be among the things it points at.
   */
  it('describes the refused control with the reason, not only its pill', () => {
    const { editor, controls } = mount({ 'b-1': awaiting([7]) }, [paraNode('b-1')], OTHER)
    const described = controls()[0]!.getAttribute('aria-describedby')!.split(' ')
      .map(id => editor.view.dom.querySelector(`#${id}`))
      .map(el => el!.textContent || el!.getAttribute('aria-label'))
    expect(described).toContain(REFUSAL['awaiting-others'])
  })

  it('signs off where the rule takes it, and says nothing extra', () => {
    const { asked, controls } = mount({ 'b-1': awaiting([3]) }, [paraNode('b-1')], OTHER)
    const [button] = controls()
    expect(button!.hasAttribute('aria-disabled')).toBe(false)
    expect(button!.title).toBe('')
    button!.click()
    expect(asked).toEqual([['b-1', 'peer']])
  })

  it('marks a sign-off the rule allows as available', () => {
    const [button] = mount({ 'b-1': awaiting([3]) }, [paraNode('b-1')]).controls()
    expect(button!.hasAttribute('aria-disabled')).toBe(false)
  })

  /**
   * One tab stop for the whole document. Every block a moderated space has
   * been edited in carries a flag, so a control per flagged block would put a
   * tab stop between the reader and the end of the page.
   */
  it('puts only the block in hand in the tab order, and moves it with the caret', () => {
    const map: BlockMetaMap = { 'b-1': awaiting([3]), 'b-2': awaiting([3]) }
    const { editor, controls } = mount(map, [paraNode('b-1'), paraNode('b-2')])
    expect(controls().map(button => button.tabIndex)).toEqual([0, -1])

    editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 1)
    expect(controls().map(button => button.tabIndex)).toEqual([-1, 0])
  })

  /**
   * One click, one step — the statement the agent sign-off makes is not the
   * one the peer approval makes, and they are made by two people.
   */
  it('clears the agent step alone on a block owing both', () => {
    const writing = mount({ 'b-1': awaitingBoth([3]) }, [paraNode('b-1')], WRITER)
    const mine = writing.controls()
    expect(mine).toHaveLength(2)
    mine[0]!.click()
    expect(writing.asked).toEqual([['b-1', 'agent']])

    // The peer step is the writer's own writing, so it is not theirs to clear.
    mine[1]!.click()
    expect(writing.asked).toEqual([['b-1', 'agent']])

    // It is the second sign-off, by somebody else.
    const reading = mount({ 'b-1': awaitingBoth([3]) }, [paraNode('b-1')], OTHER)
    reading.controls()[1]!.click()
    expect(reading.asked).toEqual([['b-1', 'peer']])
  })

  // A block is not always a paragraph: the click has to reach a list, whose
  // own first position holds no text, and a leaf, which holds none at all.
  it('signs off a container block and a leaf block', () => {
    const map: BlockMetaMap = { 'b-list': awaiting([3]), 'b-rule': awaiting([3]) }
    const { asked, controls } = mount(map, [
      { type: 'bulletList', attrs: { id: 'b-list' }, content: [
        { type: 'listItem', content: [paraNode('item')] },
      ] },
      { type: 'horizontalRule', attrs: { id: 'b-rule' } },
    ])
    controls()[0]!.click()
    controls()[1]!.click()
    expect(asked).toEqual([['b-list', 'peer'], ['b-rule', 'peer']])
  })

  it('signs off the block its pill hangs on, not the block holding the caret', () => {
    const map: BlockMetaMap = { 'b-1': awaiting([3]), 'b-2': awaitingAgent([3]) }
    const { editor, asked, controls } = mount(map, [paraNode('b-1'), paraNode('b-2')])
    controls()[1]!.click()
    expect(asked).toEqual([['b-2', 'agent']])
    // The caret follows the click: the control is rebuilt out from under it,
    // and the block just signed off is where the reader is.
    expect(topLevelBlockPos(editor.state)).toBe(editor.state.doc.child(0).nodeSize)
  })
})

describe('the plugin', () => {
  const map: BlockMetaMap = { 'b-1': signedOff('fago') }

  function stateWith(text: string): EditorState {
    return EditorState.create({
      schema: editorSchema,
      doc: doc(para(text, 'b-1')),
      plugins: [createReviewMarksPlugin(sidecarLookup(map, undefined, OTHER))],
    })
  }

  // One marked block draws two decorations: the state on the block, the pills
  // in a widget inside it.
  it('projects the sidecar at init', () => {
    expect(reviewMarksKey.getState(stateWith('original'))!.find()).toHaveLength(2)
  })

  it('re-projects on a document change, so a flag Drupal set shows at once', () => {
    const local: BlockMetaMap = { 'b-1': signedOff('fago') }
    const state = EditorState.create({
      schema: editorSchema,
      doc: doc(para('original', 'b-1')),
      plugins: [createReviewMarksPlugin(sidecarLookup(local, undefined, OTHER))],
    })
    expect((reviewMarksKey.getState(state)!.find()[0] as unknown as
      { type: { attrs: Record<string, string> } }).type.attrs.class).toContain('reviewed')

    // The write that changed the block is what re-stamped the flag; the
    // editor only has to re-read the sidecar, never to work staleness out.
    local['b-1'] = awaiting()
    const next = state.apply(state.tr.insertText('!', 9))
    expect((reviewMarksKey.getState(next)!.find()[0] as unknown as
      { type: { attrs: Record<string, string> } }).type.attrs.class).toContain('reviewable')
  })

  it('keeps the same decoration set across a transaction that changed nothing', () => {
    const state = stateWith('original')
    const next = state.apply(state.tr)
    expect(reviewMarksKey.getState(next)).toBe(reviewMarksKey.getState(state))
  })

  // The block the caret is in carries the boundary class the board is drawn
  // from — the only signal a touch device has, since it cannot hover.
  it('marks the block the caret is in, and moves the mark with the caret', () => {
    const d = doc(para('first', 'b-1'), para('second', 'b-2'))
    const state = EditorState.create({
      schema: editorSchema,
      doc: d,
      selection: TextSelection.near(d.resolve(1), 1),
    })
    expect(activeBlockDecoration(state)!.from).toBe(0)

    const moved = state.apply(state.tr.setSelection(
      TextSelection.near(d.resolve(d.child(0).nodeSize + 1), 1),
    ))
    expect(activeBlockDecoration(moved)!.from).toBe(d.child(0).nodeSize)
  })

  it('names no block when the selection names none', () => {
    const d = doc(para('first', 'b-1'))
    expect(activeBlockDecoration(
      EditorState.create({ schema: editorSchema, doc: d, selection: new AllSelection(d) }),
    )).toBeNull()
  })

  // Its own plugin, so the review marks' decoration set stays exactly the
  // sidecar's projection and the two never have to be told apart.
  it('draws the caret\u2019s block from a plugin of its own', () => {
    const d = doc(para('first', 'b-1'), para('second', 'b-2'))
    const plugin = createActiveBlockPlugin()
    const drawn = (s2: EditorState) => plugin.props.decorations!.call(plugin, s2) as DecorationSet | null
    const caretAt = (pos: number) => EditorState.create({
      schema: editorSchema,
      doc: d,
      selection: TextSelection.near(d.resolve(pos), 1),
      plugins: [createReviewMarksPlugin(sidecarLookup(map, undefined, OTHER)), plugin],
    })

    const first = caretAt(1)
    expect(reviewMarksKey.getState(first)!.find().map(dec => dec.from)).toEqual([0, 1])
    expect(drawn(first)!.find().map(dec => dec.from)).toEqual([0])
    expect(drawn(caretAt(d.child(0).nodeSize + 1))!.find().map(dec => dec.from))
      .toEqual([d.child(0).nodeSize])
  })

  it('rebuilds on the refresh meta, so a peer sign-off shows without a doc update', () => {
    const sidecar: BlockMetaMap = {}
    const state = EditorState.create({
      schema: editorSchema,
      doc: doc(para('text', 'b-1')),
      plugins: [createReviewMarksPlugin(sidecarLookup(sidecar, undefined, OTHER))],
    })
    expect(reviewMarksKey.getState(state)!.find()).toHaveLength(0)

    // A peer's sign-off is mirrored in: the Y.Map changes, the document does not.
    sidecar['b-1'] = signedOff('peer')
    const refreshed = state.apply(state.tr.setMeta('okb-review-refresh', true))
    expect(reviewMarksKey.getState(refreshed)!.find()).toHaveLength(2)
  })
})

/**
 * The review drawer's list (OKB-121).
 *
 * The queue exists to send an editor somewhere, so what it must get right is
 * the mapping from a flag to a place: document order, the right position, and
 * nothing pointing at a block that is not there any more.
 */
describe('reviewQueue', () => {
  it('lists the flagged blocks in document order, whatever order the sidecar names them in', () => {
    const document = doc(para('first', 'b-1'), para('second', 'b-2'), para('third', 'b-3'))
    const rows = reviewQueue(document, { 'b-3': ['peer'], 'b-1': ['agent'] }, {}, OTHER)
    expect(rows.map(r => r.id)).toEqual(['b-1', 'b-3'])
  })

  it('carries each block text and the steps it owes', () => {
    const rows = reviewQueue(doc(para('needs a look', 'b-1')), { 'b-1': ['agent', 'peer'] }, {}, OTHER)
    expect(rows).toEqual([{
      id: 'b-1',
      kind: 'block',
      pos: 0,
      text: 'needs a look',
      steps: ['agent', 'peer'],
      state: 'unattributed',
      approvals: [approves('agent', 'unattributed'), approves('peer', 'unattributed')],
    }])
  })

  /**
   * The row says whose move it is, off the same rule the gutter mark uses —
   * so the drawer can lead with "you can sign off N of them" rather than
   * listing everything as equally actionable.
   */
  it('states, per row, whether this reader can clear it', () => {
    const document = doc(para('mine', 'b-1'), para('theirs', 'b-2'), para('orphan', 'b-3'))
    const meta: BlockMetaMap = { 'b-1': awaiting([3]), 'b-2': awaiting([7]), 'b-3': awaiting([]) }
    const owed = { 'b-1': ['peer' as const], 'b-2': ['peer' as const], 'b-3': ['peer' as const] }
    const rows = reviewQueue(document, owed, meta, WRITER)
    expect(rows.map(r => r.state)).toEqual(['awaiting-others', 'reviewable', 'unattributed'])
    expect(reviewableCount(rows)).toBe(1)
  })

  // The drawer counts an estimate for the peer it is drawn for, so its headline
  // agrees with the pills beside the blocks.
  it('counts a mirrored estimate as the reader\'s to sign off', () => {
    const document = doc(para('just typed', 'b-1'))
    const meta: BlockMetaMap = { 'b-1': estimated([3]) }
    const owed = { 'b-1': ['peer' as const] }

    expect(reviewQueue(document, owed, meta, OTHER).map(r => r.state)).toEqual(['reviewable'])
    expect(reviewableCount(reviewQueue(document, owed, meta, OTHER))).toBe(1)
    expect(reviewableCount(reviewQueue(document, owed, meta, WRITER))).toBe(0)
  })

  it('offers the whole queue to a moderator', () => {
    const document = doc(para('mine', 'b-1'), para('orphan', 'b-2'))
    const meta: BlockMetaMap = { 'b-1': awaiting([9]), 'b-2': awaiting([]) }
    const owed = { 'b-1': ['peer' as const], 'b-2': ['peer' as const] }
    expect(reviewableCount(reviewQueue(document, owed, meta, MODERATOR))).toBe(2)
  })

  /**
   * A row folded in from the server's own refusal names a block the mirrored
   * sidecar has not caught up on yet. There is no episode to read, so it
   * reports as unattributed — the conservative answer, and the affordance
   * comes back the moment the sidecar lands.
   */
  it('reads a row with no sidecar entry conservatively', () => {
    const rows = reviewQueue(doc(para('refused', 'b-1')), { 'b-1': ['peer'] }, {}, OTHER)
    expect(rows.map(r => r.state)).toEqual(['unattributed'])
  })

  it('gives a position the editor can select — one that resolves inside the block', () => {
    const document = doc(para('first', 'b-1'), para('second', 'b-2'))
    const [row] = reviewQueue(document, { 'b-2': ['peer'] }, {}, OTHER)
    expect(document.resolve(row!.pos + 1).parent.attrs.id).toBe('b-2')
  })

  it('lists a review item the document holds no block for, after the blocks', () => {
    // A removed block and the title are changes with no text in the document.
    // Dropping them would hold the page back with nothing on screen saying so.
    const rows = reviewQueue(
      doc(para('here', 'b-1')),
      { 'b-1': ['peer'], 'b-gone': ['peer'], 'field:title': ['peer'] },
      {},
      OTHER,
    )
    expect(rows.map(r => [r.id, r.kind, r.pos]))
      .toEqual([['b-1', 'block', 0], ['b-gone', 'removed', null], ['field:title', 'field', null]])
  })

  it('offers the sign-off on a row with no block, since no pill can carry it', () => {
    const meta: BlockMetaMap = { 'field:title': awaiting([3]) }
    const [row] = reviewQueue(doc(para('here', 'b-1')), { 'field:title': ['peer'] }, meta, WRITER)
    expect(row!.approvals).toEqual([{
      step: 'peer',
      label: approveActionLabel('peer'),
      refusal: 'The page title needs a second pair of eyes: its only contributor is the account approving it.',
    }])
    expect(reviewQueue(doc(para('here', 'b-1')), { 'field:title': ['peer'] }, meta, OTHER)[0]!.approvals[0]!.refusal)
      .toBeNull()
  })

  it('omits a block with no flag, and one with an empty step list', () => {
    const document = doc(para('clean', 'b-1'), para('also clean', 'b-2'))
    expect(reviewQueue(document, { 'b-2': [] }, {}, OTHER)).toEqual([])
  })

  it('tells a block the draft only moved apart from one it changed', () => {
    // Same text, same place in the row — the only difference is where the
    // page says it, so nothing but the kind can say what is under review.
    const document = doc(para('same words', 'b-1'), para('edited', 'b-2'))
    const meta: BlockMetaMap = { 'b-1': { ...awaiting([3]), moved: true }, 'b-2': awaiting([3]) }
    const rows = reviewQueue(document, { 'b-1': ['peer'], 'b-2': ['peer'] }, meta, OTHER)
    expect(rows.map(r => [r.id, r.kind, r.pos])).toEqual([['b-1', 'moved', 0], ['b-2', 'block', 12]])
  })

  it('lists a flag naming a block that bears no id in the document as removed', () => {
    // From the document's side the block is gone, and the gate is holding on
    // the record either way — so it is listed rather than hidden.
    const rows = reviewQueue(doc(para('no id', null)), { 'b-1': ['peer'] }, {}, OTHER)
    expect(rows.map(r => [r.id, r.kind])).toEqual([['b-1', 'removed']])
  })
})

describe('reviewToggleLabel', () => {
  const assigned = (mine: number, myAgents: number) => ({ mine, myAgents, total: mine + myAgents })

  it('names every hold the badges cannot, and says only "Review" with none', () => {
    expect(reviewToggleLabel({ unidentified: 0, awaiting: 0, reviewableNow: 0, assigned: assigned(0, 0) }))
      .toBe('Review')
    expect(reviewToggleLabel({ unidentified: 0, awaiting: 3, reviewableNow: 1, assigned: assigned(2, 0) }))
      .toBe('Review — 3 awaiting, 1 you can sign off, 2 comments assigned to you')
    expect(reviewToggleLabel({ unidentified: 0, awaiting: 3, reviewableNow: 0, assigned: assigned(0, 0) }))
      .toBe('Review — 3 awaiting, none of them yours to sign off')
  })

  it('splits the badge\'s one number back into whose move each part is', () => {
    expect(reviewToggleLabel({ unidentified: 0, awaiting: 0, reviewableNow: 0, assigned: assigned(2, 1) }))
      .toBe('Review — 2 comments assigned to you, 1 to your agents')
    expect(reviewToggleLabel({ unidentified: 0, awaiting: 0, reviewableNow: 0, assigned: assigned(0, 1) }))
      .toBe('Review — 1 comment assigned to your agents')
    expect(reviewToggleLabel({ unidentified: 0, awaiting: 0, reviewableNow: 0, assigned: assigned(1, 0) }))
      .toBe('Review — 1 comment assigned to you')
  })

  it('keeps the awaiting count when an id-less block holds the page too', () => {
    // Two different holds, cleared by two different moves — the badge shows
    // only the gate's count, so a reader on the label alone must get both.
    expect(reviewToggleLabel({ unidentified: 1, awaiting: 15, reviewableNow: 2, assigned: assigned(0, 0) }))
      .toBe('Review — 1 block without an id, 15 awaiting, 2 you can sign off')
  })
})
