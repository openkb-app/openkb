import { Extension } from '@tiptap/core'
import { isChangeOrigin } from '@tiptap/extension-collaboration'
import { NodeSelection, Plugin, PluginKey, Selection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { ReplaceStep } from '@tiptap/pm/transform'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { usedBlockIds } from './block-id-minter'
import { widgetDrawnOncePerDecoration } from './widget-drawn-once'
import { addressableBlocks, reviewPills, type AddressableBlock, type PillApproval, type ReviewLookup, type ReviewPill } from './review-model'
import { blockIdOf, ID_BEARING_TYPES, mintBlockId, type ReviewStep } from '#shared/page-blocks'

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
 * it is anchored to the block it is about; where {@link marksInside} says no,
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
 * dispatches {@link refreshReviewMarks} after each Y transaction that changes
 * the Y.Map.
 */

/**
 * Whether a block's margin marks hang inside it, or ride an anchor after it.
 * - A leaf has no inside.
 * - A code block's highlight tokens re-wrap its text as it is typed. A widget
 *   beside that text is re-drawn with it, which moves Chrome's caret to the
 *   block start.
 */
export function marksInside(node: PMNode): boolean {
  return !node.isLeaf && !node.type.spec.code
}

/**
 * The uneditable span a margin control hangs from:
 * - inside a block, `okb-margin-anchor`: it draws no box, so the block's text
 *   lines are all ProseMirror measures for `endOfTextblock`;
 * - after a block without an inside, `okb-margin-gap`: empty, the prose
 *   margins collapse through it, so nothing moves.
 */
export function marginAnchor(control: HTMLElement, inside: boolean): HTMLElement {
  const anchor = document.createElement('span')
  anchor.className = inside ? 'okb-margin-anchor' : 'okb-margin-gap'
  anchor.contentEditable = 'false'
  anchor.append(control)
  return anchor
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
  return { id: blockIdOf(node), pos, node }
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

/** What one block's pills need to know beyond what they say. */
interface PillsDomOptions {
  /** The block's id, which the pills' aria wiring keys on. */
  blockId: string
  /**
   * False where {@link marksInside} says so (a leaf, a code block): the
   * pills ride an empty anchor placed right after the block. The anchor
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
  return marginAnchor(host, options.inside)
}

/**
 * The block a pills widget belongs to: the one it hangs inside, or the one it
 * rides the gap after.
 */
function widgetBlockPos(doc: PMNode, pos: number): number | null {
  const $pos = doc.resolve(pos)
  if ($pos.depth > 0) return $pos.before(1)
  const block = $pos.nodeBefore
  return block ? pos - block.nodeSize : null
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
    const inside = marksInside(node)
    const inHand = activePos === pos
    decorations.push(Decoration.widget(
      inside ? pos + 1 : pos + node.nodeSize,
      widgetDrawnOncePerDecoration((view, getPos) => pillsDom(pills, {
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
      })),
      {
        side: -1,
        // Firefox puts a Home caret inside the control; PM reads it as the block start.
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
 * Whether every step of a transaction edits inside one top-level block's
 * content and keeps the block count. Such an edit leaves every block
 * decoration where mapping puts it, so the marks map instead of rebuilding.
 * Anything else rebuilds: a markup change, a split or join, a block deleted
 * and re-inserted (a drag dropped back in place).
 */
export function editsInsideBlocks(tr: Transaction): boolean {
  return tr.steps.every((step, i) => {
    if (!(step instanceof ReplaceStep)) return false
    const before = tr.docs[i]!
    if (before.childCount !== (tr.docs[i + 1] ?? tr.doc).childCount) return false
    const $from = before.resolve(step.from)
    return $from.depth > 0 && step.to <= $from.end(1)
  })
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
      // selection change. A local edit inside the blocks maps the set.
      apply(tr, value, oldState, newState) {
        const activePos = topLevelBlockPos(newState)
        const wasActive = topLevelBlockPos(oldState)
        if (!tr.getMeta(REFRESH)) {
          if (!tr.docChanged && activePos === wasActive) return value
          if (tr.docChanged && !isChangeOrigin(tr) && editsInsideBlocks(tr)
            && activePos === (wasActive === null ? null : tr.mapping.map(wasActive))) {
            return value.map(tr.mapping, tr.doc)
          }
        }
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
