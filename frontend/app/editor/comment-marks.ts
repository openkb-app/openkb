import { Extension } from '@tiptap/core'
import { isChangeOrigin } from '@tiptap/extension-collaboration'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { addressableBlocks, blockAt, blockAtSelection, ensureBlockId, topLevelBlockPos, type AddressableBlock } from './review-marks'
import { openThreads, resolveAnchor, type CommentAnchor, type CommentThread } from '#shared/block-comments'

/**
 * Inline comments in the editor (OKB-121) — the surface half of the model in
 * `shared/block-comments.ts`.
 *
 * A commented block is marked twice, and the two say different things. The
 * range the thread was opened on is highlighted where it can still be found,
 * so the conversation points at the words it is about. The block itself
 * carries the open-thread count, so a thread whose words have since been
 * rewritten is still visible — degrading to block-level is the model's answer
 * to a moved anchor ({@link resolveAnchor}), and a mark that vanished with the
 * quote would silently lose the conversation instead.
 *
 * Like the review marks this is a projection and holds no state: the threads
 * live in the `blockMeta` Y.Map and are read through a `threads` seam, so the
 * whole thing tests against a plain `EditorState`.
 */

/** Reads the threads currently in the sidecar. */
export type ThreadLookup = () => CommentThread[]

/**
 * The offset within a block's inline content that holds text offset
 * `textOffset` — the inverse of the mapping {@link anchorAtSelection} does.
 *
 * The two differ wherever a block holds inline content that is not text (an
 * inline image, a hard break): such a node occupies a position and contributes
 * no characters, so counting one as the other would drift the highlight for
 * every character after it.
 */
export function contentOffsetOf(node: PMNode, textOffset: number): number {
  let text = 0
  let found: number | null = null
  node.forEach((child, offset) => {
    if (found !== null) return
    const length = child.isText ? child.text!.length : 0
    if (text + length >= textOffset) found = offset + (child.isText ? textOffset - text : 0)
    else text += length
  })
  return found ?? node.content.size
}

/**
 * The range a thread opened on, as offsets into the block's TEXT rather than
 * into its inline content — the two coincide for a plain paragraph and part
 * ways as soon as it holds anything else, and text offsets are the half that
 * survives being stored and re-read against a re-parsed document.
 *
 * Null when the selection is empty: a caret is a place, not a passage, and a
 * thread opened there is about the block.
 */
export function anchorAtSelection(state: EditorState): CommentAnchor | null {
  const head = state.selection.$head
  if (head.depth === 0) return null
  const pos = head.before(1)
  const node = state.doc.nodeAt(pos)
  if (!node) return null
  const start = pos + 1
  const from = Math.max(0, Math.min(state.selection.from - start, node.content.size))
  const to = Math.max(from, Math.min(state.selection.to - start, node.content.size))
  if (from === to) return null
  return {
    from: node.textBetween(0, from).length,
    to: node.textBetween(0, to).length,
    quote: node.textBetween(from, to),
  }
}

/**
 * The whole of a block as an anchor — the subject of a comment opened without a
 * passage, so the thread names the block's own words rather than degrading to a
 * bare "this block". Read off the block itself, it does not depend on a live
 * selection surviving the toolbar press, and the projection resolves it over
 * the block's full text ({@link resolveAnchor}).
 *
 * Null for an empty block: there are no words to quote, and a caret-only note on
 * it is genuinely about the block.
 */
export function blockAnchor(block: { text: string }): CommentAnchor | null {
  return block.text.length ? { from: 0, to: block.text.length, quote: block.text } : null
}

/**
 * The passage marked inside the block at `pos`, or null when nothing is.
 *
 * A thread hangs on one block, so only a selection that lies wholly inside
 * that block marks a passage on it. A caret marks none, and a selection
 * reaching into its neighbours marks the blocks, not a passage in any of them.
 */
export function markedPassage(state: EditorState, pos: number): CommentAnchor | null {
  const node = state.doc.nodeAt(pos)
  if (!node) return null
  const { from, to } = state.selection
  if (from < pos + 1 || to > pos + node.nodeSize - 1) return null
  return anchorAtSelection(state)
}

export const commentAnchorKey = new PluginKey<RememberedAnchor | null>('commentAnchor')

/** The passage a selection covered, and the block it was in. */
export interface RememberedAnchor {
  /** Document position of the block the selection was inside. */
  pos: number
  anchor: CommentAnchor
}

/**
 * Remembers the last passage the cursor covered, for as long as the cursor
 * stays in its block.
 *
 * The comment action lives in the toolbar, which is OUTSIDE the editable
 * surface: pressing it takes focus off `contenteditable`, the browser drops
 * the DOM selection, and ProseMirror reads that back as a collapsed one. By
 * the time the command runs, the passage the reader marked is gone from the
 * state — the thread would silently attach to the whole block instead of to
 * the words they highlighted.
 *
 * So the anchor is taken while it still exists, on the transaction that
 * carried it, and handed to the command afterwards. It is dropped the moment
 * the cursor leaves that block, which is what keeps this a repair for the
 * blur and not a second, staler source of truth: a reader who selects a
 * passage, clicks into another block and then comments gets a comment on the
 * block they are actually in.
 *
 * The block menu collapses the selection the same way, by selecting the whole
 * block as it opens. That selection has not left the block, so the memory
 * holds across it.
 */
export function createCommentAnchorPlugin(): Plugin<RememberedAnchor | null> {
  return new Plugin<RememberedAnchor | null>({
    key: commentAnchorKey,
    state: {
      init: () => null,
      apply(tr, value, _oldState, newState) {
        const pos = topLevelBlockPos(newState)
        const anchor = pos === null ? null : markedPassage(newState, pos)
        if (pos !== null && anchor) return { pos, anchor }
        if (!value) return null
        // A collapsed selection keeps the memory only while it is still in the
        // block the passage was in; the position moves with the document.
        const mapped = tr.docChanged ? tr.mapping.map(value.pos) : value.pos
        return pos === mapped ? { ...value, pos: mapped } : null
      },
    },
  })
}

/** The remembered passage for `pos`, or null when there is none for it. */
export function rememberedAnchor(state: EditorState, pos: number): CommentAnchor | null {
  const held = commentAnchorKey.getState(state)
  return held && held.pos === pos ? held.anchor : null
}

/** A thread as the drawer lists it: the thread plus its block's text. */
export interface CommentThreadView extends CommentThread {
  blockText: string
}

/**
 * The threads as the drawer lists them — in the order they were opened, each
 * carrying the text of the block it is on.
 *
 * The block's text rides along because a thread names the passage it is about,
 * and one opened on a whole block — or one whose passage has since been
 * rewritten ({@link resolveAnchor}) — has only the block to name instead. A
 * thread whose block has left the document is dropped: there is nowhere to
 * send anybody, exactly as in the review queue beside it.
 */
export function commentRows(doc: PMNode, threads: CommentThread[]): CommentThreadView[] {
  const text = new Map(addressableBlocks(doc).map(b => [b.id, b.text]))
  return threads
    .filter(thread => text.has(thread.blockId))
    .map(thread => ({ ...thread, blockText: text.get(thread.blockId) ?? '' }))
}

/**
 * A press on a block's comment badge. `at` makes each press a signal of its
 * own: the page watches this to open the drawer, and a bare block id would go
 * unnoticed the second time the same badge is pressed.
 */
export interface ShownThreads {
  blockId: string
  /** The one comment to open, when a click landed on its passage. */
  threadId?: string
  at: number
}

/** What the margin control does, given the block it sits beside. */
export interface CommentMarginActions {
  /** Opens a block's comments, or one comment of that block. */
  showThreads: (blockId: string, threadId?: string) => void
  /** Starts one on the block at `pos`, which may carry no id yet. */
  startThread: (pos: number) => void
}

/** How many open conversations each block carries, by block id. */
export function threadCounts(threads: CommentThread[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const { blockId, resolved } of threads) {
    if (!resolved) counts.set(blockId, (counts.get(blockId) ?? 0) + 1)
  }
  return counts
}

/**
 * The control in a block's margin: the conversation on it, or an offer to
 * start one. Its words come from CSS (main.css) — the control sits inside the
 * block, so text here would join the block's own.
 */
function marginControl(
  id: string | null,
  count: number,
  getPos: () => number | undefined,
  actions: CommentMarginActions,
): HTMLElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.contentEditable = 'false'
  // A press must not take the selection with it.
  button.addEventListener('mousedown', event => event.preventDefault())
  if (count > 0 && id) {
    button.className = 'okb-comment-badge'
    button.dataset.count = String(count)
    // "Comment on this block" is the toolbar button's name, and two controls
    // answering to one name is a coin flip for anything addressing them by it.
    button.setAttribute('aria-label', count === 1
      ? 'Open the conversation on this block'
      : `Open the ${count} conversations on this block`)
    button.addEventListener('click', () => actions.showThreads(id))
  }
  else {
    // Out of the tab order: one tab stop per block. Its own name, so it does
    // not answer to the toolbar button's.
    const label = 'Start a conversation on this block'
    button.className = 'okb-comment-start'
    button.tabIndex = -1
    button.setAttribute('aria-label', label)
    button.title = label
    button.addEventListener('click', () => {
      const pos = getPos()
      if (pos !== undefined) actions.startThread(pos)
    })
  }
  return button
}

/**
 * One margin control per block, and the class that positions it.
 *
 * Anchored like the review pills (review-marks.ts): inside the block where it
 * has an inside, on the empty anchor after it where it has none. Keyed on what
 * it says, so only the blocks whose count changed redraw.
 */
export function marginDecorations(
  doc: PMNode,
  counts: ReadonlyMap<string, number>,
  actions: CommentMarginActions,
): DecorationSet {
  const decorations: Decoration[] = []
  for (const { id, pos, node } of addressableBlocks(doc)) {
    const count = id ? counts.get(id) ?? 0 : 0
    const inside = !node.isLeaf
    // The block's own position, which is what a fresh thread is opened on.
    const offset = inside ? 1 : node.nodeSize
    decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'okb-margin-host' }))
    decorations.push(Decoration.widget(
      pos + offset,
      (_view, getPos) => {
        const control = marginControl(id, count, () => {
          const at = getPos()
          return at === undefined ? undefined : at - offset
        }, actions)
        return inside ? control : marginGap(control)
      },
      {
        side: -1,
        // One key for every block that carries no id: they all draw the same
        // offer, and keying those by position redraws them on any edit above.
        key: id ? `comment-margin-${id}-${count}` : 'comment-margin-offer',
        ignoreSelection: true,
        // The control handles its own events; none of them are the document's.
        stopEvent: () => true,
      },
    ))
  }
  return DecorationSet.create(doc, decorations)
}

/**
 * A leaf block (an image, a rule) has no inside, so its control rides an empty
 * anchor after it — the prose margins collapse through it, so nothing moves.
 */
function marginGap(control: HTMLElement): HTMLElement {
  const anchor = document.createElement('span')
  anchor.className = 'okb-margin-gap'
  anchor.contentEditable = 'false'
  anchor.append(control)
  return anchor
}

/**
 * Projects the open threads onto the document. Pure over (doc, threads), so
 * the projection is exercised without a view.
 */
export function commentDecorations(doc: PMNode, threads: CommentThread[]): DecorationSet {
  const decorations: Decoration[] = []
  for (const { id, pos, node, text } of addressableBlocks(doc)) {
    if (!id) continue
    const open = openThreads(threads, id)
    if (open.length === 0) continue
    decorations.push(Decoration.node(pos, pos + node.nodeSize, {
      'class': 'okb-comment-block',
      'data-comment-count': String(open.length),
    }))
    for (const thread of open) {
      const range = resolveAnchor(thread.anchor, text)
      if (!range) continue
      const start = pos + 1
      decorations.push(Decoration.inline(
        start + contentOffsetOf(node, range.from),
        start + contentOffsetOf(node, range.to),
        { class: 'okb-comment-range', 'data-comment-thread': thread.threadId },
        { blockId: id, threadId: thread.threadId },
      ))
    }
  }
  return DecorationSet.create(doc, decorations)
}

/** Which comment an inline highlight belongs to. */
export interface RangeSpec {
  blockId: string
  threadId: string
}

/** What a click on a passage opens: one comment, else the block's whole list. */
export interface CommentHit {
  blockId: string
  threadId?: string
}

/**
 * The comment whose highlighted passage covers `pos`, or null. A passage holds
 * its start and not its end. The shortest passage wins, so overlaps resolve to
 * the most specific comment; two equally long ones give no comment, so the
 * block's list opens.
 */
export function threadAt(decorations: DecorationSet, pos: number): CommentHit | null {
  let found: { hit: CommentHit, width: number } | null = null
  for (const { from, to, spec } of decorations.find(pos, pos)) {
    const { blockId, threadId } = spec as Partial<RangeSpec>
    if (!threadId || !blockId || to <= pos) continue
    const width = to - from
    if (!found || width < found.width) found = { hit: { blockId, threadId }, width }
    else if (width === found.width && threadId !== found.hit.threadId) {
      found = { hit: { blockId }, width }
    }
  }
  return found?.hit ?? null
}

export const commentMarksKey = new PluginKey<DecorationSet>('commentMarks')

/** Transaction meta that forces a rebuild without a document change. */
const REFRESH = 'okb-comment-refresh'

/**
 * Rebuilds the marks against the current sidecar — a comment written here or
 * by a peer changes no document content, so nothing else would.
 */
export function refreshCommentMarks(view: { state: EditorState, dispatch: (tr: Transaction) => void }): void {
  view.dispatch(view.state.tr.setMeta(REFRESH, true))
}

export function createCommentMarksPlugin(
  threads: ThreadLookup,
  showThreads: CommentMarginActions['showThreads'],
): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: commentMarksKey,
    state: {
      init: (_config, state) => commentDecorations(state.doc, threads()),
      apply(tr, value, _oldState, newState) {
        // The set is first built when the editor opens, before the document
        // has its content, so content arriving from the store has to rebuild
        // it. A local edit maps the set, so a tint follows the words the
        // reader types inside it.
        if (tr.getMeta(REFRESH) || (tr.docChanged && isChangeOrigin(tr))) {
          return commentDecorations(newState.doc, threads())
        }
        return tr.docChanged ? value.map(tr.mapping, tr.doc) : value
      },
    },
    props: {
      decorations: state => commentMarksKey.getState(state),
      // Clicking a highlighted passage opens its comment in the review
      // surface. Returns false so the click still places the caret: the
      // passage is editable text.
      handleClick(view, pos) {
        const hit = threadAt(commentMarksKey.getState(view.state) ?? DecorationSet.empty, pos)
        if (hit) showThreads(hit.blockId, hit.threadId)
        return false
      },
    },
  })
}

/** The margin controls, and the thread counts they were drawn from. */
interface MarginState {
  counts: ReadonlyMap<string, number>
  decorations: DecorationSet
}

export const commentMarginKey = new PluginKey<MarginState>('commentMargin')

/**
 * The margin controls, rebuilt on every change rather than mapped: a block
 * pasted in, split off or newly synced needs a control of its own, and mapping
 * only moves the controls a set already holds. The counts are re-read only
 * when the sidecar changes, so a keystroke costs no read of the comment store.
 */
export function createCommentMarginPlugin(
  threads: ThreadLookup,
  actions: CommentMarginActions,
): Plugin<MarginState> {
  const build = (doc: PMNode, counts: ReadonlyMap<string, number>): MarginState => ({
    counts,
    decorations: marginDecorations(doc, counts, actions),
  })
  return new Plugin<MarginState>({
    key: commentMarginKey,
    state: {
      init: (_config, state) => build(state.doc, threadCounts(threads())),
      apply(tr, value, _oldState, newState) {
        if (tr.getMeta(REFRESH)) return build(newState.doc, threadCounts(threads()))
        return tr.docChanged ? build(newState.doc, value.counts) : value
      },
    },
    props: {
      decorations: state => commentMarginKey.getState(state)?.decorations,
    },
  })
}

export interface CommentMarksOptions extends CommentMarginActions {
  /** Reads the threads out of the sidecar. */
  threads: ThreadLookup
  /** Opens a thread on `blockId`, about `anchor` or about the block. */
  openThread: (blockId: string, anchor: CommentAnchor | null) => void
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    commentMarks: {
      /**
       * Opens a comment thread on the selection, or on the block holding it.
       * `blockPos` is for a control that names a block of its own — the
       * margin's; the selection still decides the passage within it.
       */
      commentOnSelection: (blockPos?: number) => ReturnType
    }
  }
}

/**
 * What a thread opened on `block` is about: the passage marked in it, else the
 * one remembered before the press collapsed the selection (see
 * {@link createCommentAnchorPlugin}), else the whole block — so a thread
 * always names real text.
 */
function threadAnchor(state: EditorState, block: AddressableBlock): CommentAnchor | null {
  return markedPassage(state, block.pos)
    ?? rememberedAnchor(state, block.pos)
    ?? blockAnchor(block)
}

export const CommentMarks = Extension.create<CommentMarksOptions>({
  name: 'commentMarks',

  addOptions() {
    return {
      threads: () => [],
      openThread: () => {},
      showThreads: () => {},
      startThread: () => {},
    }
  },

  addProseMirrorPlugins() {
    return [
      createCommentMarksPlugin(this.options.threads, this.options.showThreads),
      createCommentMarginPlugin(this.options.threads, {
        showThreads: this.options.showThreads,
        startThread: this.options.startThread,
      }),
      createCommentAnchorPlugin(),
    ]
  },

  addCommands() {
    return {
      commentOnSelection: (blockPos?: number) => ({ state, tr, dispatch }) => {
        const block = (blockPos === undefined ? null : blockAt(state, blockPos)) ?? blockAtSelection(state)
        if (!block) return false
        const id = ensureBlockId(state, tr, block)
        if (!dispatch) return true
        this.options.openThread(id, threadAnchor(state, block))
        dispatch(tr.setMeta(REFRESH, true))
        return true
      },
    }
  },
})
