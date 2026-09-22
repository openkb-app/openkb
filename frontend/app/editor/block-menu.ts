import type { PageBlock, Reviewer, ReviewStep } from '#shared/page-blocks'
import { approveActionLabel, reviewMarkOf } from './review-marks'
import { tableOpItems } from './menu-items'

/**
 * The block menu on the drag handle — one home for what can be done to a block.
 *
 * The ⠿ handle is the anchor: `UEditorDragHandle` reports the hovered block as
 * `{node, pos}` and sets a `NodeSelection` on it when clicked, so every item
 * here addresses one block and nothing has to guess which.
 *
 * Two families of item:
 *
 *  - The **document** actions (turn into, duplicate, move, delete) carry a
 *    `kind` and a `pos`, and are executed by editor handlers — Nuxt UI's own,
 *    which already take a `pos`, plus `turnInto` in `menu-items.ts`.
 *    `mapEditorItems` derives their `disabled`/`active` state from
 *    `editor.can()`, so "where the schema allows" stays the schema's answer
 *    rather than a list maintained here.
 *  - The **clipboard**, **insert**, **review** and **comment** items are ours;
 *    they carry an `onSelect` the session supplies, and the review item
 *    carries the block's standing, read off the mirrored sidecar.
 *
 * Everything here is pure over plain data, so the whole menu is exercised
 * without an editor, a view or a Y.Doc.
 */

/** A menu item an editor handler executes, by `kind` and `pos`. */
export interface BlockCommandItem {
  kind: string
  pos: number
  /** The shape a `turnInto` item re-shapes its block to. */
  target?: string
  level?: number
  /** The TipTap table command a `tableBlockOp` item runs. */
  op?: string
  label: string
  icon: string
}

/** A menu item the session executes itself. */
export interface BlockActionItem {
  label: string
  icon: string
  disabled?: boolean
  /** A second line under the label, where one item needs to say more. */
  description?: string
  onSelect: () => void
}

/** A menu item that only opens a submenu. */
export interface BlockSubmenuItem {
  label: string
  icon: string
  children: BlockCommandItem[]
}

export type BlockMenuItem = BlockCommandItem | BlockActionItem | BlockSubmenuItem

/** The block the menu is open on, as far as the item builders are concerned. */
export interface BlockMenuNode {
  /** Document position of the block. */
  pos: number
  /** Node type name. */
  type: string
  /** Heading level, when the block is a heading. */
  level?: number
}

/** The shapes a block can be turned into, in the order the menu offers them. */
const TURN_INTO: ReadonlyArray<Omit<BlockCommandItem, 'pos' | 'kind'>> = [
  { target: 'paragraph', label: 'Text', icon: 'i-lucide-pilcrow' },
  { target: 'heading', level: 1, label: 'Heading 1', icon: 'i-lucide-heading-1' },
  { target: 'heading', level: 2, label: 'Heading 2', icon: 'i-lucide-heading-2' },
  { target: 'heading', level: 3, label: 'Heading 3', icon: 'i-lucide-heading-3' },
  { target: 'bulletList', label: 'Bullet list', icon: 'i-lucide-list' },
  { target: 'orderedList', label: 'Ordered list', icon: 'i-lucide-list-ordered' },
  { target: 'taskList', label: 'Task list', icon: 'i-lucide-list-todo' },
  { target: 'blockquote', label: 'Quote', icon: 'i-lucide-quote' },
  { target: 'codeBlock', label: 'Code block', icon: 'i-lucide-code' },
]

/** The ops a table block offers — appending only, since nothing marks a row or column here. */
const TABLE_BLOCK_OPS: readonly string[] = ['addRowAfter', 'addColumnAfter']

/**
 * The whole-table operations, offered on a table block. Label and icon come
 * from `tableOpItems`, so this surface reads like the other two. Delete is not
 * among them: the menu's own Delete already removes the selected block.
 */
export function tableTargets(block: BlockMenuNode): BlockCommandItem[] {
  if (block.type !== 'table') return []
  return tableOpItems
    .filter(item => TABLE_BLOCK_OPS.includes(item.op))
    .map(({ op, label, icon }) => ({ kind: 'tableBlockOp', op, pos: block.pos, label, icon }))
}

/**
 * The shapes this block can be turned into — the catalogue minus the one it
 * already has. A level-2 heading offers the other two levels and not its own.
 *
 * The list is only the offer. Whether a target is reachable from this block is
 * `editor.can()`'s answer, applied downstream: a target the schema refuses
 * comes out disabled rather than missing, so the menu reads the same wherever
 * it is opened.
 */
export function turnIntoTargets(block: BlockMenuNode): BlockCommandItem[] {
  return TURN_INTO
    .filter(target => !(target.target === block.type && (target.level ?? null) === (block.level ?? null)))
    .map(target => ({ ...target, kind: 'turnInto', pos: block.pos }))
}

/** Where a block stands with the review policy, as the menu states it. */
export interface ApprovalStanding {
  /**
   * 'awaiting' while an enforced step is pending, 'reviewed' once one is
   * recorded, 'none' when the block has neither. {@link hasReviewStanding} is
   * the check every review control makes.
   */
  state: 'awaiting' | 'reviewed' | 'none'
  /**
   * The step a sign-off would be recorded on, present only while one is
   * pending. Drupal refuses a sign-off on a step the block does not owe, so
   * this is the only step a control may name.
   */
  step?: ReviewStep
  /** What the item reads. */
  label: string
  /**
   * Why Drupal would refuse this reader's sign-off, or null where it would
   * take it. Only a pending step has one: a block owing none offers no entry
   * to refuse, and `step` is the field that says so.
   */
  refusal: string | null
}

/**
 * Whether a block has a review a control could act on or state.
 *
 * Drupal skips a sign-off on a block that is not pending, so a control offered
 * elsewhere would write nothing.
 */
export function hasReviewStanding(standing: ApprovalStanding): boolean {
  return standing.state !== 'none'
}

/**
 * How the review item reads on this block, which step it would clear, and
 * whether it can be taken.
 *
 * Read off {@link reviewMarkOf}, the projection the margin pills draw, so the
 * menu and the margin name one step and one verdict. `refusal` is this side's
 * reading of Drupal's rule, which every review control states before the
 * sign-off; Drupal settles it itself. A block owing both steps leads with
 * the first in REVIEW_STEPS.
 */
export function approvalStanding(
  block: PageBlock | undefined,
  steps: readonly ReviewStep[],
  reviewer: Reviewer,
): ApprovalStanding {
  const mark = reviewMarkOf(block, steps, reviewer)
  if (!mark) return { state: 'none', label: approveActionLabel('peer'), refusal: null }
  if (mark.state === 'reviewed') {
    return {
      state: 'reviewed',
      label: mark.name ? `Reviewed by ${mark.name}` : 'Reviewed',
      refusal: null,
    }
  }
  const pending = mark.steps[0]!
  return {
    state: 'awaiting',
    step: pending.step,
    label: approveActionLabel(pending.step),
    refusal: pending.refusal,
  }
}

/** What the menu is built over. */
export interface BlockMenuState {
  block: BlockMenuNode
  /** The block's sidecar entry, where it has an id the sidecar knows. */
  meta: PageBlock | undefined
  /** The steps this space enforces. */
  steps: readonly ReviewStep[]
  /** Who the menu is being opened by. */
  reviewer: Reviewer
  /** Open comment threads on this block. */
  openThreads: number
}

/** The items the session executes itself. */
export interface BlockMenuActions {
  cut: () => void
  copy: () => void
  paste: () => void
  insertBelow: () => void
  cite: () => void
  review: () => void
  comment: () => void
}

/**
 * The menu, in groups: turn into · table (on a table block) · clipboard ·
 * duplicate, insert and cite · move · review and comment · delete.
 *
 * Ours sit below the document actions because those are the muscle-memory
 * half, in the order the Nuxt UI editor template establishes; Delete is last
 * and alone, where a mis-click is least likely to land on it.
 *
 * Cut, Copy and Paste are one group and all three are the session's own: the
 * clipboard is asynchronous and the paste has to parse markdown back into
 * nodes, neither of which fits the synchronous `kind` handlers. Their
 * shortcuts sit on the block the gutter selects, so the menu names what the
 * keyboard already does rather than offering a second mechanism.
 */
export function blockMenuItems(state: BlockMenuState, actions: BlockMenuActions): BlockMenuItem[][] {
  const { pos } = state.block
  const standing = approvalStanding(state.meta, state.steps, state.reviewer)

  const tableItems = tableTargets(state.block)

  return [
    [{ label: 'Turn into', icon: 'i-lucide-repeat', children: turnIntoTargets(state.block) }],
    ...(tableItems.length ? [tableItems] : []),
    [
      { label: 'Cut', icon: 'i-lucide-scissors', onSelect: actions.cut },
      { label: 'Copy', icon: 'i-lucide-clipboard-copy', onSelect: actions.copy },
      { label: 'Paste below', icon: 'i-lucide-clipboard-paste', onSelect: actions.paste },
    ],
    [
      { kind: 'duplicate', pos, label: 'Duplicate', icon: 'i-lucide-copy-plus' },
      { label: 'Insert below…', icon: 'i-lucide-plus', onSelect: actions.insertBelow },
      { label: 'Cite a source', icon: 'i-lucide-quote', onSelect: actions.cite },
    ],
    [
      { kind: 'moveUp', pos, label: 'Move up', icon: 'i-lucide-arrow-up' },
      { kind: 'moveDown', pos, label: 'Move down', icon: 'i-lucide-arrow-down' },
    ],
    [
      // Only where the block has a review to act on or to state, and then
      // greyed at most: who it waits for is on the gutter mark beside it.
      ...(hasReviewStanding(standing)
        ? [{
            label: standing.label,
            icon: standing.state === 'reviewed' ? 'i-lucide-badge-check' : 'i-lucide-badge-plus',
            disabled: !standing.step || standing.refusal !== null,
            description: standing.refusal ?? undefined,
            onSelect: actions.review,
          }]
        : []),
      {
        label: state.openThreads > 0 ? `Comments (${state.openThreads})` : 'Comment',
        icon: 'i-lucide-message-square-plus',
        onSelect: actions.comment,
      },
    ],
    [{ kind: 'delete', pos, label: 'Delete', icon: 'i-lucide-trash-2' }],
  ]
}

/**
 * What the menu offers when the selection names no block — an `AllSelection`,
 * reachable with Ctrl+A. Says so rather than opening empty, which is the only
 * other thing a menu with nothing to act on can do.
 */
export const NO_BLOCK_MENU: BlockMenuItem[][] = [
  [{
    label: 'No block selected',
    icon: 'i-lucide-info',
    disabled: true,
    description: 'Put the cursor in a block to act on it.',
    onSelect: () => {},
  }],
]
