import type { Node as PMNode } from '@tiptap/pm/model'
import type { AssignedCounts } from './comment-assignee'
import type { CommentThread } from '#shared/block-comments'
import {
  blockIdOf,
  contributorsSince,
  hasApproved,
  holdsNothing,
  ID_BEARING_TYPES,
  mayApprove,
  NO_ACTOR_NAMES,
  owedSteps,
  REVIEW_STEPS,
  reviewOf,
  TITLE_REVIEW_KEY,
  userName,
  type ActorNames,
  type PageBlock,
  type BlockMetaMap,
  type Reviewer,
  type ReviewStep,
} from '#shared/page-blocks'

/**
 * The review model the page reads: where each block stands, the labels and the
 * queue rows. No editor runtime, so the read page imports it without TipTap;
 * the editor's marks (`review-marks.ts`) draw it.
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
 *    their own writing is all it names or they already approved it;
 *  - `unattributed` — nobody is on record as having written it; anyone may
 *    sign it off, and an identified edit names a writer.
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

/** Which of the three waiting states one pending step is in for a reader. */
function stepState(block: PageBlock | undefined, step: ReviewStep, reviewer: Reviewer): WaitingState {
  if (contributorsSince(block, step).length === 0) return 'unattributed'
  return mayApprove(block, step, reviewer) ? 'reviewable' : 'awaiting-others'
}

/**
 * Which of the three waiting states a set of pending steps is in for a reader.
 *
 * One step the reader may sign off is enough to make the block theirs to act
 * on.
 */
function waitingState(
  block: PageBlock | undefined,
  pending: readonly ReviewStep[],
  reviewer: Reviewer,
): WaitingState {
  const states = pending.map(step => stepState(block, step, reviewer))
  if (states.includes('reviewable')) return 'reviewable'
  return states.includes('unattributed') ? 'unattributed' : 'awaiting-others'
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
 * `names` resolves the reviewer of a recorded sign-off; one it does not know
 * reads unnamed.
 *
 * `subject` opens the refusal sentence, for a mark drawn on something other
 * than a block — the title takes one of these (ADR 0017).
 */
export function reviewMarkOf(
  block: PageBlock | undefined,
  steps: readonly ReviewStep[] = REVIEW_STEPS,
  reviewer: Reviewer,
  names: ActorNames = NO_ACTOR_NAMES,
  subject = 'This block',
): ReviewMark | null {
  if (!block) return null
  const pending = owedSteps(block, steps)
    .map(step => ({
      step,
      state: stepState(block, step, reviewer),
      refusal: signOffRefusal(block, step, reviewer, subject),
    }))
  if (pending.length > 0) return { state: pending[0]!.state, steps: pending }
  const signed = reviewOf(block, 'peer') ?? reviewOf(block, 'agent')
  return signed ? { state: 'reviewed', steps: [], name: userName(names, signed.uid) } : null
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
  if (mayApprove(block, step, reviewer)) return null
  if (hasApproved(block, step, reviewer.uid)) return `${subject} ${ALREADY_APPROVED}`
  return `${subject} ${REFUSAL}`
}

/** The refusal sentences `PageBlocks::refusalReason()` answers with, without their subject. */
export const ALREADY_APPROVED = 'is waiting for another writer: this account has already approved it.'
export const REFUSAL = 'needs a second pair of eyes: its only contributor is the account approving it.'

/** The lookup the session hands the extension, over a mirrored sidecar. */
export function sidecarLookup(
  meta: BlockMetaMap,
  steps: readonly ReviewStep[] = REVIEW_STEPS,
  reviewer: Reviewer,
  names: ActorNames = NO_ACTOR_NAMES,
): ReviewLookup {
  return blockId => reviewMarkOf(meta[blockId], steps, reviewer, names)
}

/** A top-level block the editor can address by id. */
export interface AddressableBlock {
  id: string | null
  pos: number
  node: PMNode
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
    out.push({ id: blockIdOf(node), pos: offset, node })
  })
  return out
}

/**
 * What a block reads as in the review and comment lists: its text, or for a
 * block holding only an image, a file or an embed, its alt text, description or title.
 */
export function blockLabel(node: PMNode): string {
  if (node.textContent.trim()) return node.textContent
  let label = ''
  const name = (embed: PMNode) => {
    if (embed.type.name === 'image') label = embed.attrs.alt ? `Image: ${embed.attrs.alt}` : 'Image'
    else if (embed.type.name === 'attachment') label = embed.attrs.description ? `File: ${embed.attrs.description}` : 'File'
    else if (embed.type.name === 'embed') label = embed.attrs.title ? `Embed: ${embed.attrs.title}` : 'Embed'
  }
  name(node)
  node.descendants((child) => {
    if (!label) name(child)
    return !label
  })
  return label
}

/**
 * The blocks Drupal reads as text outside identified blocks: no id, and
 * something in them. An empty paragraph is stored without an id and shows no
 * text, so it holds nothing back — counting it would put a hold on every blank
 * line an editor leaves behind.
 */
export function unidentifiedBlocks(doc: PMNode): AddressableBlock[] {
  return addressableBlocks(doc).filter(block => !block.id && !holdsNothing(block.node))
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
    case 'unattributed': return 'Pending review, no writer on record'
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
 * people. The agent pill leads.
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
  /** The block's {@link blockLabel}, for an excerpt the editor will
   *  recognise. Empty where the document holds no block. */
  text: string
  /** The steps this item owes, in blocker-list order. */
  steps: ReviewStep[]
  /** Whose move it is — the same rule the gutter mark is drawn from. */
  state: WaitingState
  /** One sign-off per step owed, with the refusal where the rule turns this
   *  reader down — what a row with no block offers in place of a pill. */
  approvals: PillApproval[]
}

/** A block with no id, as the review panel lists it: where it is and its text. */
export interface UnidentifiedRow {
  pos: number
  text: string
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
  for (const { id, pos, node } of addressableBlocks(doc)) {
    const steps = id ? awaiting[id] : undefined
    if (!id || !steps?.length) continue
    placed.add(id)
    rows.push({
      id,
      kind: meta[id]?.moved ? 'moved' : 'block',
      pos,
      text: blockLabel(node),
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

/** "3 changes", "1 change". */
export function changesLabel(count: number): string {
  return count === 1 ? '1 change' : `${count} changes`
}

/**
 * The one toast an "approve all" is answered with: what was taken, Drupal's
 * refusals grouped by reason, and what stays with somebody else.
 *
 * - `approved`: the changes approved.
 * - `refusals`: per refused change, its distinct reasons.
 * - `waiting`: the changes that still need somebody else.
 */
export function bulkSignOffToast(approved: number, refusals: ReadonlyArray<readonly string[]>, waiting: number) {
  const left = waiting > 0 ? `${changesLabel(waiting)} still ${waiting === 1 ? 'needs' : 'need'} approval by somebody else.` : ''
  if (refusals.length === 0) {
    return {
      title: `Approved ${changesLabel(approved)}.`,
      description: left || undefined,
      icon: 'i-lucide-check-check',
      color: 'success' as const,
    }
  }
  const counts = new Map<string, number>()
  for (const reason of refusals.flat()) counts.set(reason, (counts.get(reason) ?? 0) + 1)
  const grouped = [...counts].map(([reason, count]) => (count > 1 ? `${reason} (${count}×)` : reason))
  return {
    title: `${approved} approved, ${refusals.length} refused`,
    description: [...grouped, left].filter(Boolean).join(' '),
    icon: 'i-lucide-lock',
    color: approved > 0 ? 'warning' as const : 'error' as const,
  }
}

/** `step:item`, the key a sign-off is matched by. */
export function signOffKey(entry: { item: string, step: string }): string {
  return `${entry.step}:${entry.item}`
}

/**
 * The rows this reader may still sign off, each with its steps. Leaves out the
 * keys Drupal refused them in this session. One count for the panel's line, its
 * button and the dialog.
 */
export function signableRows(rows: readonly ReviewQueueRow[], refused: readonly string[] = []) {
  return rows
    .map(row => ({
      item: row.id,
      steps: row.approvals
        .filter(({ step, refusal }) => refusal === null && !refused.includes(signOffKey({ item: row.id, step })))
        .map(({ step }) => step),
    }))
    .filter(row => row.steps.length > 0)
}

/** Drupal's answer to the sign-offs a checkpoint carried, as `_meta.review` holds it. */
export interface ReviewAnswer {
  at?: number
  approved?: Array<{ item: string, step: string, uid: number }>
  refused?: Array<{ item: string, step: string, uid: number, reason: string }>
}

/** An "approve all" waiting for its answer. */
export interface BulkSignOff {
  /** The `step:item` keys it sent. */
  keys: readonly string[]
  /** How many changes it left to somebody else. */
  waiting: number
}

/**
 * What one answer means for this reader.
 *
 * - `refused`: the session's refused keys; a key taken now drops out.
 * - `toasts`: one for the entries of `bulk`, one per other refusal.
 * - `bulk`: null once its entries arrived.
 *
 * Entries of other readers are ignored.
 */
export function reviewAnswerFor(
  answer: ReviewAnswer,
  uid: number,
  refused: readonly string[],
  bulk: BulkSignOff | null,
) {
  const approved = (answer.approved ?? []).filter(entry => entry.uid === uid)
  const denied = (answer.refused ?? []).filter(entry => entry.uid === uid)
  const taken = new Set(approved.map(signOffKey))
  const nextRefused = [...new Set([...refused.filter(key => !taken.has(key)), ...denied.map(signOffKey)])]

  const sent = new Set(bulk?.keys ?? [])
  const inBulk = (entry: { item: string, step: string }) => sent.has(signOffKey(entry))
  const toasts: Array<ReturnType<typeof bulkSignOffToast>> = []
  let nextBulk = bulk
  if (bulk && [...approved, ...denied].some(inBulk)) {
    // Counted in changes: a change refused on any step counts as refused.
    const refusals = new Map<string, Set<string>>()
    for (const entry of denied.filter(inBulk)) {
      refusals.set(entry.item, (refusals.get(entry.item) ?? new Set()).add(entry.reason))
    }
    const signed = new Set(approved.filter(inBulk).map(entry => entry.item).filter(item => !refusals.has(item)))
    toasts.push(bulkSignOffToast(signed.size, [...refusals.values()].map(reasons => [...reasons]), bulk.waiting))
    nextBulk = null
  }
  for (const entry of denied.filter(entry => !(bulk && inBulk(entry)))) {
    toasts.push({
      title: 'Sign-off refused',
      description: entry.reason,
      icon: 'i-lucide-lock',
      color: 'error' as const,
    })
  }
  return { refused: nextRefused, toasts, bulk: nextBulk }
}

/** Whether this reader may sign off at least one step the row owes. */
export function isYours(row: ReviewQueueRow): boolean {
  return row.approvals.some(approval => approval.refusal === null)
}

/** A thread as the drawer lists it: the thread plus its block's text. */
export interface CommentThreadView extends CommentThread {
  blockText: string
}

/**
 * The threads as the drawer lists them — in the order they were opened, each
 * carrying the {@link blockLabel} of the block it is on.
 *
 * The block's text rides along because a thread names the passage it is about,
 * and one opened on a whole block — or one whose passage has since been
 * rewritten ({@link resolveAnchor}) — has only the block to name instead. A
 * thread whose block has left the document is dropped: there is nowhere to
 * send anybody, exactly as in the review queue beside it.
 */
export function commentRows(doc: PMNode, threads: CommentThread[]): CommentThreadView[] {
  const text = new Map(addressableBlocks(doc).map(b => [b.id, blockLabel(b.node)]))
  return threads
    .filter(thread => text.has(thread.blockId))
    .map(thread => ({ ...thread, blockText: text.get(thread.blockId) ?? '' }))
}
