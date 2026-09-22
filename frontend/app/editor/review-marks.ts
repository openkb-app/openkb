import { Extension } from '@tiptap/core'
import { NodeSelection, Plugin, PluginKey, Selection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { AssignedCounts } from './comment-assignee'
import { usedBlockIds } from './block-id-minter'
import {
  blockIdOf,
  contributorsSince,
  holdsNothing,
  ID_BEARING_TYPES,
  isPending,
  mayApprove,
  mintBlockId,
  REVIEW_STEPS,
  reviewOf,
  TITLE_REVIEW_KEY,
  type PageBlock,
  type BlockMetaMap,
  type Reviewer,
  type ReviewStep,
} from '#shared/page-blocks'

/**
 * Review marks in the editor — the visible half of the flag model in
 * `shared/page-blocks.ts`.
 *
 * Per block, the sidecar records what it still owes (`pending:<step>`) and what
 * it has had (`review:<step>`). Both are Drupal's own facts, mirrored into the
 * session document; this module only projects them onto the editing surface
 * and provides the action that asks Drupal to clear one.
 *
 * A flag the collaboration server has witnessed but not yet delivered carries
 * `estimated` and is drawn like any other, so the mark follows the edit. It is
 * acted on like any other too: its four-eyes baseline is the writer set that
 * server witnessed, and the checkpoint a sign-off rides on carries the session
 * before Drupal weighs it.
 *
 * There is no staleness to compute. An edit landing on a block re-stamps its
 * flag at the write that carried it, so a sign-off the surface still shows is
 * one that still holds — the editor never has to second-guess a record by
 * re-reading the text under it.
 *
 * The state lives in the `blockMeta` Y.Map, not here. It is read through a
 * `lookup` seam, so the sidecar, Y.js and the session's identity all stay out
 * of the editor layer and the projection unit-tests against a plain
 * `EditorState`.
 *
 * ## A node decoration for the state, a widget for the pills
 *
 * Where a block stands is a class on the block itself, which CSS draws as the
 * coloured rule down its left margin (`main.css`).
 *
 * The pills are DOM, because a block owing both steps draws two of them in two
 * colours: a `content` string is one text run in one colour, so one box cannot
 * draw two pills. The right end of their margin line belongs to the comment
 * control (`comment-marks.ts`), which the row leaves clear.
 *
 * The widget holds no state of its own: it is rebuilt from the sidecar on
 * every redraw and keyed by what it draws, so there is nothing that can
 * desynchronise from the block it describes. It is placed inside the block, so
 * it is anchored to the block it is about; a leaf block has no inside, and
 * {@link pillsDom} says what happens there.
 *
 * A pill for a step still owed carries the checkmark that clears it, so the
 * sign-off is one click away from the block it is about. The widget's events
 * are the widget's own (`stopEvent`), and its DOM is `contenteditable=false`,
 * so a click moves neither the caret nor the text under it. Only the control
 * on the block in hand is in the tab order, which keeps a page of flagged
 * blocks from becoming a page of tab stops; every other block's control is
 * reached by putting the caret in the block, which is how a keyboard gets
 * there anyway.
 *
 * ## Redraw
 *
 * Decorations are rebuilt when the document changes AND when the sidecar
 * changes underneath an unchanged document (a peer reviewing a block sends no
 * doc update at all). The latter has no transaction of its own, so the session
 * observing the Y.Map dispatches {@link refreshReviewMarks}.
 */

/**
 * Where a block stands with the reader in front of it.
 *
 * The three waiting states are Drupal's own approve rule
 * ({@link mayApprove}) read as a question about this reader, so a reviewer
 * sees which blocks are theirs to clear before they try one:
 *
 *  - `reviewable` — they may sign it off now;
 *  - `awaiting-others` — it is waiting on eyes that are not theirs, because
 *    their own writing is all it names;
 *  - `unattributed` — nobody is on record as having written it, so only an
 *    admin can clear it and an identified edit is what unblocks it.
 */
export type ReviewMarkState = 'reviewable' | 'awaiting-others' | 'unattributed' | 'reviewed'

/** The states a block that still owes a review can be in. */
export type WaitingState = Exclude<ReviewMarkState, 'reviewed'>

/** One pending step, and whose move it is on that step. */
export interface ReviewMarkStep {
  step: ReviewStep
  state: WaitingState
  /** Why this reader's sign-off would be refused, or null where it would be taken. */
  refusal: string | null
}

/** What the sidecar says about one block, as far as the editor is concerned. */
export interface ReviewMark {
  /** The primary step's standing, or `reviewed` once nothing is owed. */
  state: ReviewMarkState
  /**
   * The steps still owed, in {@link REVIEW_STEPS} order — agent first, so a
   * block owing both leads with the approval that comes first. Empty on a
   * block that owes nothing.
   */
  steps: ReviewMarkStep[]
  /** Reviewer display name, when a sign-off captured one. */
  name?: string | null
}

/** Reads the review standing of a block from the sidecar. */
export type ReviewLookup = (blockId: string) => ReviewMark | null

/**
 * Which of the three waiting states one pending step is in for a reader.
 *
 * The two answers below `reviewable` differ in what unblocks them: an episode
 * naming nobody needs an identified edit (or an admin), an episode naming only
 * this reader needs a second pair of eyes.
 */
function stepState(block: PageBlock | undefined, step: ReviewStep, reviewer: Reviewer): WaitingState {
  if (mayApprove(block, step, reviewer)) return 'reviewable'
  return contributorsSince(block, step).length > 0 ? 'awaiting-others' : 'unattributed'
}

/**
 * Which of the three waiting states a set of pending steps is in for a reader.
 *
 * One approvable step is enough to make the block theirs to act on.
 */
function waitingState(
  block: PageBlock | undefined,
  pending: readonly ReviewStep[],
  reviewer: Reviewer,
): WaitingState {
  const states = pending.map(step => stepState(block, step, reviewer))
  if (states.includes('reviewable')) return 'reviewable'
  return states.includes('awaiting-others') ? 'awaiting-others' : 'unattributed'
}

/**
 * The mark one block carries, under the steps this space enforces and for the
 * account reading it.
 *
 * Filtered by the policy for the same reason the drawer's queue is: a step the
 * space does not ask for holds no publication up, so a margin chip reading
 * "Awaiting review" for it would send the editor to a queue the drawer
 * correctly reports as empty. A wiki space is where the two disagree — it
 * enforces `agent` and not `peer`, and every edit stamps `pending:peer`.
 *
 * A recorded sign-off is reported whichever step it was given on: that one
 * happened is a fact about the block, not a question about the policy — and
 * not a question about who is looking either.
 *
 * `reviewer` is required where `steps` defaults, because the two fail opposite
 * ways: an unknown policy shows every chip, an unknown reader would hide every
 * affordance — quietly switching off the thing this projection exists to draw.
 *
 * `steps` is the policy's *set*: which steps this space asks for. The order a
 * block owing both is reported in is {@link REVIEW_STEPS}, never the caller's.
 *
 * `subject` opens the refusal sentence, for a mark drawn on something other
 * than a block — the title takes one of these (ADR 0017).
 */
export function reviewMarkOf(
  block: PageBlock | undefined,
  steps: readonly ReviewStep[] = REVIEW_STEPS,
  reviewer: Reviewer,
  subject = 'This block',
): ReviewMark | null {
  if (!block) return null
  const pending = REVIEW_STEPS
    .filter(step => steps.includes(step) && isPending(block, step))
    .map(step => ({
      step,
      state: stepState(block, step, reviewer),
      refusal: signOffRefusal(block, step, reviewer, subject),
    }))
  if (pending.length > 0) return { state: pending[0]!.state, steps: pending }
  const signed = reviewOf(block, 'peer') ?? reviewOf(block, 'agent')
  return signed ? { state: 'reviewed', steps: [], name: signed.name } : null
}

/**
 * Why Drupal would refuse this reader's sign-off, or null where it would take
 * it. Same facts as {@link mayApprove}, so the control says no before the
 * reviewer clicks; Drupal stays the authority, and answers a block that
 * changed under
 * the reader in `_meta.review`.
 *
 * About a step the block owes. A step it does not owe has nothing to refuse
 * and nothing to sign off, and draws no control to ask with.
 *
 * `subject` is how the sentence opens. The default is for a control beside the
 * block it is about; a row in the review panel names its item instead, because
 * a removed block and the title are nowhere to be looked at.
 */
export function signOffRefusal(
  block: PageBlock | undefined,
  step: ReviewStep,
  reviewer: Reviewer,
  subject = 'This block',
): string | null {
  const sentence = REFUSAL[stepState(block, step, reviewer)]
  return sentence === null ? null : `${subject} ${sentence}`
}

/**
 * The two refusal sentences `PageBlocks::refusalReason()` answers with,
 * keyed by the state that produces them, and without their subject.
 */
const REFUSAL: Record<WaitingState, string | null> = {
  'reviewable': null,
  'awaiting-others': 'needs a second pair of eyes: its only contributor is the account approving it.',
  'unattributed': 'needs an identified edit before anybody can sign it off: nothing on record says who wrote it.',
}

/** The lookup the session hands the extension, over a mirrored sidecar. */
export function sidecarLookup(
  meta: BlockMetaMap,
  steps: readonly ReviewStep[] = REVIEW_STEPS,
  reviewer: Reviewer,
): ReviewLookup {
  return blockId => reviewMarkOf(meta[blockId], steps, reviewer)
}

/** A top-level block the editor can address by id. */
export interface AddressableBlock {
  id: string | null
  pos: number
  node: PMNode
  text: string
}

/**
 * The top-level id-bearing blocks of a document, in document order. Nested
 * blocks are not provenance units (see shared/page-blocks.ts), so a review
 * can only ever attach to one of these.
 */
export function addressableBlocks(doc: PMNode): AddressableBlock[] {
  const out: AddressableBlock[] = []
  doc.forEach((node, offset) => {
    if (!ID_BEARING_TYPES.has(node.type.name)) return
    out.push({ id: blockIdOf(node), pos: offset, node, text: node.textContent })
  })
  return out
}

/**
 * The blocks Drupal reads as text outside identified blocks: no id, and
 * something in them. An empty paragraph serializes to nothing, so it holds
 * nothing back — counting it would put a hold on every blank line an editor
 * leaves behind.
 */
export function unidentifiedBlocks(doc: PMNode): AddressableBlock[] {
  return addressableBlocks(doc).filter(block => !block.id && !holdsNothing(block.node))
}

/**
 * The block's id, minted onto the document first if it has none.
 *
 * The id tracker only mints on an edit, so a block nobody has touched in this
 * session may still carry none — and both things a reader can do to a block,
 * signing it off and commenting on it, have to name one. Minting here is the
 * alternative to refusing the action over bookkeeping the reader cannot see.
 *
 * The write is deliberately not an authorship event: it carries no text, and
 * `addToHistory: false` keeps it out of undo, where it would otherwise be a
 * step that appears to do nothing.
 */
export function ensureBlockId(state: EditorState, tr: Transaction, block: AddressableBlock): string {
  if (block.id) return block.id
  const used = usedBlockIds(state.doc)
  let id = mintBlockId()
  while (used.has(id)) id = mintBlockId()
  tr.setNodeAttribute(block.pos, 'id', id)
  tr.setMeta('addToHistory', false)
  return id
}

/** The addressable block at `pos`, or null when nothing id-bearing sits there. */
export function blockAt(state: EditorState, pos: number): AddressableBlock | null {
  const node = state.doc.nodeAt(pos)
  if (!node || !ID_BEARING_TYPES.has(node.type.name)) return null
  return { id: blockIdOf(node), pos, node, text: node.textContent }
}

/**
 * Position of the top-level block the selection names, or null when it names
 * none (an `AllSelection`).
 *
 * Two selection shapes reach here, and both name one block. A caret is read
 * through its head; a `NodeSelection` on a top-level block — what the block
 * menu sets when it opens — is the block itself, and resolves to depth 0,
 * where a head-based read finds nothing.
 */
export function topLevelBlockPos(state: EditorState): number | null {
  const { selection } = state
  if (selection instanceof NodeSelection && selection.$anchor.depth === 0) {
    return selection.from
  }
  const head = selection.$head
  return head.depth === 0 ? null : head.before(1)
}

/**
 * The addressable block the selection is on, or null when it sits in something
 * that bears no id (a list item, a table cell) — those degrade to
 * document-level and cannot be signed off individually in v1.
 *
 * Both selection shapes resolve here, which is what lets the block menu and
 * the navbar's own review/comment buttons run one command each rather than
 * two.
 */
export function blockAtSelection(state: EditorState): AddressableBlock | null {
  const pos = topLevelBlockPos(state)
  return pos === null ? null : blockAt(state, pos)
}

/**
 * The label one pending step carries.
 *
 * Each label names the review that is owed, and the verb says whose move it
 * is: "Pending" is the reader's own, "Waiting for" somebody else's. Naming the
 * review rather than a person is what tells the reader what would clear the
 * block.
 *
 * The agent step has one label whatever the state: anyone who may write the
 * space may clear it ({@link mayApprove}), so it is never somebody else's
 * move. It also names itself, because it is drawn in its own colour and a
 * reader who cannot tell violet from blue reads the difference here.
 */
export function stepMarkLabel({ step, state }: Pick<ReviewMarkStep, 'step' | 'state'>): string {
  if (step === 'agent') return 'Pending agent review'
  switch (state) {
    case 'reviewable': return 'Pending peer review'
    case 'awaiting-others': return 'Waiting for peer review'
    case 'unattributed': return 'Pending admin review'
  }
}

/**
 * What the control clearing one step is called — the wording the block menu
 * gives the same action, so the margin and the menu name one thing once.
 */
export function approveActionLabel(step: ReviewStep): string {
  return step === 'agent' ? 'Sign off the agent write' : 'Mark reviewed'
}

/**
 * Names each hold separately; the badge shows only the gate's total.
 */
export function reviewToggleLabel(counts: {
  unidentified: number
  awaiting: number
  reviewableNow: number
  assigned: AssignedCounts
}): string {
  const parts: string[] = []
  if (counts.unidentified > 0) {
    parts.push(`${counts.unidentified} block${counts.unidentified === 1 ? '' : 's'} without an id`)
  }
  if (counts.awaiting > 0) {
    const yours = counts.reviewableNow > 0
      ? `${counts.reviewableNow} you can sign off`
      : 'none of them yours to sign off'
    parts.push(`${counts.awaiting} awaiting, ${yours}`)
  }
  // The badge carries one number; whose move each part of it is reads here.
  const { mine, myAgents, total } = counts.assigned
  if (total > 0) {
    const comments = (n: number): string => `${n} comment${n === 1 ? '' : 's'}`
    if (myAgents === 0) parts.push(`${comments(mine)} assigned to you`)
    else if (mine === 0) parts.push(`${comments(myAgents)} assigned to your agents`)
    else parts.push(`${comments(mine)} assigned to you, ${myAgents} to your agents`)
  }
  return parts.length > 0 ? `Review — ${parts.join(', ')}` : 'Review'
}

/** The checkmark one pending pill carries. */
export interface PillApproval {
  /** The step one sign-off clears. A block owing both is two pills and two controls. */
  step: ReviewStep
  /** The control's accessible name. */
  label: string
  /**
   * What the sign-off would be refused with ({@link signOffRefusal}), or null
   * where it would be taken. A control carrying one is disabled and says the
   * reason, so the reader is told what would unblock the block instead of
   * being told no by the server.
   */
  refusal: string | null
}

/** One pill in the margin: what it says, and which colour and glyph say it. */
export interface ReviewPill {
  /** The agent step names itself; every other pill is coloured by its state. */
  tone: 'agent' | ReviewMarkState
  label: string
  /** The sign-off this pill offers. Absent on the pill recording one. */
  approve?: PillApproval
}

/**
 * The pills a mark draws — one per step still owed, agent first, or the one
 * sign-off it has.
 *
 * A block owing both steps draws two, because they are two approvals by two
 * people. The agent pill leads, and its colour is the one the left rule
 * carries.
 */
export function reviewPills(mark: ReviewMark): ReviewPill[] {
  if (mark.state === 'reviewed') {
    return [{ tone: 'reviewed', label: mark.name ? `Reviewed by ${mark.name}` : 'Reviewed' }]
  }
  return mark.steps.map(({ step, state, refusal }) => ({
    tone: step === 'agent' ? 'agent' as const : state,
    label: stepMarkLabel({ step, state }),
    approve: { step, label: approveActionLabel(step), refusal },
  }))
}

/** How a step reads where it is named to a human. */
export const STEP_LABEL: Record<ReviewStep, string> = {
  peer: 'Waiting for a second pair of eyes',
  agent: 'Waiting on a human to read what the agent wrote',
}

/**
 * What one review item stands for, which decides how its row reads and acts.
 *
 * `block` and `moved` are blocks the document holds; a `moved` one reads the
 * same and differs only in where the page says it, so its row says so. The
 * other two have no node to walk to, so their row carries the sign-off itself
 * (ADR 0017).
 */
export type ReviewItemKind = 'block' | 'moved' | 'removed' | 'field'

/** One review item in the queue: what it owes, and how to find it. */
export interface ReviewQueueRow {
  id: string
  /** What the row stands for. */
  kind: ReviewItemKind
  /** Position in the document, or null for an item it holds no block for. */
  pos: number | null
  /** The block's text, for an excerpt the editor will recognise. Empty where
   *  the document holds no block. */
  text: string
  /** The steps this item owes, in blocker-list order. */
  steps: ReviewStep[]
  /** Whose move it is — the same rule the gutter mark is drawn from. */
  state: WaitingState
  /** One sign-off per step owed, with the refusal where the rule turns this
   *  reader down — what a row with no block offers in place of a pill. */
  approvals: PillApproval[]
}

/** How a review item names itself where there is no text to recognise it by. */
export function itemName(id: string): string {
  return id === TITLE_REVIEW_KEY ? 'The page title' : `Block ${id}`
}

/** The sign-offs one item's owed steps offer this reader. */
function approvalsFor(
  block: PageBlock | undefined,
  steps: readonly ReviewStep[],
  reviewer: Reviewer,
  subject: string,
): PillApproval[] {
  return steps.map(step => ({
    step,
    label: approveActionLabel(step),
    refusal: signOffRefusal(block, step, reviewer, subject),
  }))
}

/**
 * The review items holding a publication up — the panel's list.
 *
 * The blocks come first, in document order: the panel is a list of places to
 * go, and an editor works down a page. The items the document holds no block
 * for follow, because there is nowhere to send anybody for them — a removed
 * block and the title are signed off from the row itself.
 */
export function reviewQueue(
  doc: PMNode,
  awaiting: Record<string, ReviewStep[]>,
  meta: BlockMetaMap,
  reviewer: Reviewer,
): ReviewQueueRow[] {
  const rows: ReviewQueueRow[] = []
  const placed = new Set<string>()
  for (const { id, pos, text } of addressableBlocks(doc)) {
    const steps = id ? awaiting[id] : undefined
    if (!id || !steps?.length) continue
    placed.add(id)
    rows.push({
      id,
      kind: meta[id]?.moved ? 'moved' : 'block',
      pos,
      text,
      steps,
      state: waitingState(meta[id], steps, reviewer),
      approvals: approvalsFor(meta[id], steps, reviewer, 'This block'),
    })
  }
  for (const [id, steps] of Object.entries(awaiting)) {
    if (placed.has(id) || !steps.length) continue
    rows.push({
      id,
      kind: id === TITLE_REVIEW_KEY ? 'field' : 'removed',
      pos: null,
      text: '',
      steps,
      state: waitingState(meta[id], steps, reviewer),
      approvals: approvalsFor(meta[id], steps, reviewer, itemName(id)),
    })
  }
  return rows
}

/** How many of these rows this reader can act on — the drawer's headline. */
export function reviewableCount(rows: readonly ReviewQueueRow[]): number {
  return rows.filter(row => row.state === 'reviewable').length
}

/** What one block's pills need to know beyond what they say. */
interface PillsDomOptions {
  /** The block's id, which the pills' aria wiring keys on. */
  blockId: string
  /**
   * False for a leaf block (an image, a rule): it has no inside to hang the
   * pills in, so they ride an empty anchor placed right after it. The anchor
   * carries no height, border or padding, so the prose margins around it
   * collapse through it and nothing moves.
   */
  inside: boolean
  /** True on the block holding the selection, whose control is the tab stop. */
  inHand: boolean
  /** Asks Drupal to clear one step on this block. */
  onApprove: (step: ReviewStep) => void
}

/**
 * The checkmark that clears one step.
 *
 * Named by the action and described by the pill beside it, so the words CSS
 * draws reach a reader who cannot see them and the step is announced rather
 * than only coloured. The reference is by id, so it holds across the two
 * being siblings rather than one holding the other.
 *
 * Its pill's tone rides along as a class: the palette keys on the class, and
 * the control is not inside the pill to inherit it.
 *
 * A refused control takes no click; the reason is its tooltip and describes
 * it. `aria-disabled`, not `disabled`: a disabled button draws no tooltip and
 * leaves the tab order.
 */
function approveDom(approve: PillApproval, tone: ReviewPill['tone'], describedBy: string, options: PillsDomOptions): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `okb-review-approve okb-review-approve--${tone}`
  button.setAttribute('aria-label', approve.label)
  button.setAttribute('aria-describedby', describedBy)
  if (approve.refusal) {
    button.setAttribute('aria-disabled', 'true')
    button.title = approve.refusal
  }
  button.tabIndex = options.inHand ? 0 : -1
  // No caret placement on the click: the sign-off puts it on the block itself.
  button.addEventListener('mousedown', event => event.preventDefault())
  button.addEventListener('click', () => {
    if (!approve.refusal) options.onApprove(approve.step)
  })
  return button
}

/** The pills' DOM, built fresh per mark and owned by the widget. */
function pillsDom(pills: readonly ReviewPill[], options: PillsDomOptions): HTMLElement {
  const host = document.createElement('span')
  host.className = 'okb-review-pills'
  host.contentEditable = 'false'
  for (const pill of pills) {
    const el = document.createElement('span')
    el.className = `okb-review-pill okb-review-pill--${pill.tone}`
    // The words are an attribute CSS draws, not child text: the widget sits
    // inside the block, and text there would join the block's own. The same
    // words as `aria-label`, which is what an `aria-describedby` reference
    // reads off an element whose only text is drawn.
    el.setAttribute('data-review-label', pill.label)
    host.append(el)
    // The checkmark stands beside its pill rather than in it: the pill clips
    // to its own box for the ellipsis, and the control is the larger of the
    // two.
    if (pill.approve) {
      el.id = `okb-review-${options.blockId}-${pill.approve.step}`
      el.setAttribute('aria-label', pill.label)
      const ids = [el.id]
      // A `title` is dropped wherever `aria-describedby` answers, so the
      // reason is a described element too.
      if (pill.approve.refusal) {
        const why = document.createElement('span')
        why.className = 'sr-only'
        why.id = `okb-review-${options.blockId}-${pill.approve.step}-why`
        why.textContent = pill.approve.refusal
        host.append(why)
        ids.push(why.id)
      }
      host.append(approveDom(pill.approve, pill.tone, ids.join(' '), options))
    }
  }
  if (options.inside) return host
  const anchor = document.createElement('span')
  anchor.className = 'okb-margin-gap'
  anchor.contentEditable = 'false'
  anchor.append(host)
  return anchor
}

/**
 * The block a pills widget belongs to: the one it hangs inside, or the leaf it
 * rides the gap after.
 */
function widgetBlockPos(doc: PMNode, pos: number): number | null {
  const $pos = doc.resolve(pos)
  if ($pos.depth > 0) return $pos.before(1)
  const leaf = $pos.nodeBefore
  return leaf ? pos - leaf.nodeSize : null
}

/** What the projection needs beyond the document and the sidecar. */
export interface ReviewDecorationOptions {
  /**
   * Start position of the block holding the selection. Its checkmark is the
   * document's one tab stop; every other one is skipped.
   */
  activePos?: number | null
  /** Asks Drupal to clear one step on the block starting at `pos`. */
  approve?: (pos: number, step: ReviewStep) => void
}

/**
 * Projects the sidecar onto the document — a node decoration carrying the
 * state as classes, and a widget drawing one pill per step owed. Pure over its
 * arguments and the pills are built lazily, so the whole projection is
 * exercised without a view or a DOM.
 */
export function reviewDecorations(
  doc: PMNode,
  lookup: ReviewLookup,
  { activePos = null, approve }: ReviewDecorationOptions = {},
): DecorationSet {
  const decorations: Decoration[] = []
  for (const { id, pos, node } of addressableBlocks(doc)) {
    if (!id) continue
    const mark = lookup(id)
    if (!mark) continue
    const steps = mark.steps.map(({ step }) => ` okb-review--${step}`).join('')
    decorations.push(Decoration.node(pos, pos + node.nodeSize, {
      class: `okb-review okb-review--${mark.state}${steps}`,
    }))
    const pills = reviewPills(mark)
    const inside = !node.isLeaf
    const inHand = activePos === pos
    decorations.push(Decoration.widget(
      inside ? pos + 1 : pos + node.nodeSize,
      (view, getPos) => pillsDom(pills, {
        blockId: id,
        inside,
        inHand,
        // Read at the click, not at the build: the widget outlives edits that
        // move the block it hangs on.
        onApprove: (step) => {
          const at = getPos()
          const block = at === undefined ? null : widgetBlockPos(view.state.doc, at)
          if (block !== null) approve?.(block, step)
        },
      }),
      {
        side: -1,
        ignoreSelection: true,
        // The control handles its own events; none of them are the document's.
        stopEvent: () => true,
        // Identity, so a mark that changed redraws and one that did not is kept.
        key: `okb-review ${id}${inHand ? ' in-hand' : ''} ${pills.map(pill => `${pill.tone}:${pill.label}`).join('|')}`,
        pills,
      },
    ))
  }
  return DecorationSet.create(doc, decorations)
}

/**
 * The block the caret is in, marked so CSS can draw its boundary
 * (`.okb-block-active` in `main.css`).
 *
 * A margin mark says nothing about which block it describes unless that
 * block's own edge is visible. The pointer answers that on a device that has
 * one, in CSS alone; the caret is what answers on touch, and on the block
 * being typed in, and no selector names it — ProseMirror gives a class to a
 * node selection, never to the block a cursor sits in.
 *
 * The same class gates the review label. One block's margin is the next
 * block's margin too, so only the block in hand shows its pill; every other
 * marked block carries the coloured rule alone.
 *
 * A class on the existing node, like the review mark: nothing of ours is
 * inserted between collaboratively-edited blocks.
 */
export function activeBlockDecoration(state: EditorState): Decoration | null {
  const pos = topLevelBlockPos(state)
  if (pos === null) return null
  const node = state.doc.nodeAt(pos)
  return node ? Decoration.node(pos, pos + node.nodeSize, { class: 'okb-block-active' }) : null
}

export const activeBlockKey = new PluginKey<DecorationSet>('activeBlock')

/**
 * Draws {@link activeBlockDecoration}. Its own plugin, and stateless: the
 * answer is one decoration read off the selection, so there is nothing to
 * cache and nothing to invalidate.
 */
export function createActiveBlockPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: activeBlockKey,
    props: {
      decorations(state) {
        const decoration = activeBlockDecoration(state)
        return decoration ? DecorationSet.create(state.doc, [decoration]) : null
      },
    },
  })
}

export const reviewMarksKey = new PluginKey<DecorationSet>('reviewMarks')

/** Transaction meta that forces a rebuild without a document change. */
const REFRESH = 'okb-review-refresh'

/**
 * Rebuilds the marks against the current sidecar. Called when the sidecar
 * changed but the document did not — a sign-off Drupal recorded and the collab
 * server mirrored back, which touches the Y.Map and never the doc.
 */
export function refreshReviewMarks(view: { state: EditorState, dispatch: (tr: Transaction) => void }): void {
  view.dispatch(view.state.tr.setMeta(REFRESH, true))
}

/**
 * `approve` is what turns a checkmark into a request; without one the pills
 * are drawn and the clicks go nowhere, which is what the projection tests
 * exercise.
 */
export function createReviewMarksPlugin(
  lookup: ReviewLookup,
  approve?: (pos: number, step: ReviewStep) => void,
): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: reviewMarksKey,
    state: {
      init: (_config, state) => reviewDecorations(state.doc, lookup, {
        activePos: topLevelBlockPos(state),
        approve,
      }),
      // Which block is in hand is a selection fact, not a document one, so the
      // marks rebuild when the caret crosses a block boundary and at no other
      // selection change.
      apply(tr, value, oldState, newState) {
        const activePos = topLevelBlockPos(newState)
        if (!tr.docChanged && !tr.getMeta(REFRESH) && activePos === topLevelBlockPos(oldState)) return value
        return reviewDecorations(newState.doc, lookup, { activePos, approve })
      },
    },
    props: {
      decorations: state => reviewMarksKey.getState(state),
    },
  })
}

export interface ReviewMarksOptions {
  /** Reads a block's review standing out of the sidecar. */
  lookup: ReviewLookup
  /** Asks Drupal to record the local actor's sign-off on a block's step. */
  approve: (blockId: string, step: ReviewStep) => void
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    reviewMarks: {
      /** Asks Drupal to sign the local actor off on the block at the cursor. */
      approveBlockAtCursor: (step: ReviewStep) => ReturnType
    }
  }
}

export const ReviewMarks = Extension.create<ReviewMarksOptions>({
  name: 'reviewMarks',

  addOptions() {
    return {
      lookup: () => null,
      approve: () => {},
    }
  },

  addProseMirrorPlugins() {
    const { editor } = this
    /**
     * A checkmark click: the selection goes to the block it names, and the
     * sign-off runs there — reached from the margin instead of the toolbar.
     *
     * Focus returns to the editor because the control is rebuilt out from
     * under the click, and a caret on the block just signed off is where the
     * reader is going next.
     *
     * One call for the three shapes an id-bearing block comes in:
     * {@link Selection.near} lands a caret in a text block, finds one inside a
     * container (a list, a quote, a table) whose own first position holds
     * none, and takes a node selection on a leaf.
     */
    const approveAt = (pos: number, step: ReviewStep) => {
      editor.chain()
        .focus()
        .command(({ tr }) => {
          tr.setSelection(Selection.near(tr.doc.resolve(pos), 1))
          return true
        })
        .approveBlockAtCursor(step)
        .run()
    }
    return [createReviewMarksPlugin(this.options.lookup, approveAt), createActiveBlockPlugin()]
  },

  addCommands() {
    return {
      approveBlockAtCursor: (step: ReviewStep) => ({ state, tr, dispatch }) => {
        const block = blockAtSelection(state)
        if (!block) return false
        const id = ensureBlockId(state, tr, block)
        if (!dispatch) return true
        this.options.approve(id, step)
        // Re-project immediately: the answer arrives asynchronously and moves
        // no document content, so nothing else would rebuild the decorations.
        dispatch(tr.setMeta(REFRESH, true))
        return true
      },
    }
  },
})
