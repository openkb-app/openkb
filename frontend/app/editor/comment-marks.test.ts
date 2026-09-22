// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import * as Y from 'yjs'
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state'
import { DecorationSet } from '@tiptap/pm/view'
import { ySyncPluginKey } from '@tiptap/y-tiptap'
import type { Node as PMNode } from '@tiptap/pm/model'
import { editorSchema } from '../../server/utils/editor-schema'
import { readThreads, recordCommentMessage, type CommentThread } from '#shared/block-comments'
import {
  anchorAtSelection,
  type CommentMarginActions,
  blockAnchor,
  CommentMarks,
  commentDecorations,
  commentMarksKey,
  commentRows,
  createCommentMarksPlugin,
  marginDecorations,
  threadCounts,
  contentOffsetOf,
  createCommentAnchorPlugin,
  markedPassage,
  rememberedAnchor,
  threadAt,
} from './comment-marks'

const AT = 1_700_000_000_000

function para(text: string, id: string | null): PMNode {
  return editorSchema.node('paragraph', { id }, text ? [editorSchema.text(text)] : [])
}
function doc(...blocks: PMNode[]): PMNode {
  return editorSchema.node('doc', null, blocks)
}

/** A thread on `blockId`, about `quote` where one is given. */
function thread(blockId: string, quote: string | null, from = 0, to = 0): CommentThread {
  const session = new Y.Doc()
  recordCommentMessage(session, blockId, 'c-1', 'm-a', {
    uid: 7,
    name: 'Ada',
    at: AT,
    text: 'is this right?',
    ...(quote ? { anchor: { from, to, quote } } : {}),
  })
  return readThreads(session)[0]!
}

/** Every decoration's attributes, in document order. */
function specs(d: PMNode, threads: CommentThread[]): Array<Record<string, unknown>> {
  return commentDecorations(d, threads)
    .find()
    .map(x => (x as unknown as { type: { attrs: Record<string, unknown> } }).type.attrs)
}

/** The document ranges the decorations cover, in document order. */
function ranges(d: PMNode, threads: CommentThread[]): Array<[number, number]> {
  return commentDecorations(d, threads).find().map(x => [x.from, x.to])
}

const NO_ACTIONS: CommentMarginActions = { showThreads: () => {}, startThread: () => {} }

/** The margin control of each block, as the DOM it renders. */
function margins(d: PMNode, threads: CommentThread[], actions: CommentMarginActions = NO_ACTIONS): HTMLElement[] {
  return marginDecorations(d, threadCounts(threads), actions)
    .find()
    .filter(x => 'toDOM' in (x as unknown as { type: object }).type)
    .map(x => (x as unknown as {
      type: { toDOM: (view: unknown, getPos: () => number) => HTMLElement }
    }).type.toDOM(null, () => x.from))
}

describe('commentDecorations', () => {
  it('marks a block with the number of conversations open on it', () => {
    const d = doc(para('The quick brown fox', 'b-1'))
    expect(specs(d, [thread('b-1', null)])).toEqual([
      { 'class': 'okb-comment-block', 'data-comment-count': '1' },
    ])
  })

  it('highlights the passage a thread was opened on', () => {
    const d = doc(para('The quick brown fox', 'b-1'))
    const attrs = specs(d, [thread('b-1', 'quick', 4, 9)])
    expect(attrs[1]).toEqual({ class: 'okb-comment-range', 'data-comment-thread': 'c-1' })
    // Block starts at 0, its text at 1 — so "quick" covers 5..10.
    expect(ranges(d, [thread('b-1', 'quick', 4, 9)])[1]).toEqual([5, 10])
  })

  it('follows the passage when an edit elsewhere in the block moved it', () => {
    const d = doc(para('Well, the quick brown fox', 'b-1'))
    expect(ranges(d, [thread('b-1', 'quick', 4, 9)])[1]).toEqual([11, 16])
  })

  it('keeps the block mark when the passage is gone — the thread degrades, it does not vanish', () => {
    const d = doc(para('The slow brown fox', 'b-1'))
    expect(specs(d, [thread('b-1', 'quick', 4, 9)])).toEqual([
      { 'class': 'okb-comment-block', 'data-comment-count': '1' },
    ])
  })

  it('leaves a resolved thread unmarked', () => {
    const session = new Y.Doc()
    recordCommentMessage(session, 'b-1', 'c-1', 'm-a', { uid: 7, at: AT, text: 'is this right?' })
    recordCommentMessage(session, 'b-1', 'c-1', 'm-r', { uid: 8, at: AT + 1, resolved: true })
    const resolved = readThreads(session)[0]!
    expect(specs(doc(para('The quick brown fox', 'b-1')), [resolved])).toEqual([])
  })

  it('ignores a thread whose block is no longer in the document', () => {
    expect(specs(doc(para('The quick brown fox', 'b-1')), [thread('b-gone', null)])).toEqual([])
  })

  it('counts every open thread on the same block', () => {
    const d = doc(para('The quick brown fox', 'b-1'))
    const two = [thread('b-1', null), { ...thread('b-1', null), threadId: 'c-2' }]
    expect(specs(d, two)[0]).toEqual({ 'class': 'okb-comment-block', 'data-comment-count': '2' })
  })
})

describe('the control in a block\'s margin', () => {
  const actions = () => {
    const shown: string[] = []
    const started: number[] = []
    return {
      shown,
      started,
      showThreads: (id: string) => shown.push(id),
      startThread: (pos: number) => started.push(pos),
    }
  }

  it('shows the count as a button that opens the conversation', () => {
    const spy = actions()
    const d = doc(para('The quick brown fox', 'b-1'))
    const [button] = margins(d, [thread('b-1', null)], spy)

    expect(button!.tagName).toBe('BUTTON')
    // The count is drawn from the attribute, so no text of the control's joins
    // the block's own words.
    expect(button!.dataset.count).toBe('1')
    expect(button!.textContent).toBe('')
    expect(button!.getAttribute('aria-label')).toBe('Open the conversation on this block')
    button!.dispatchEvent(new Event('click'))
    expect(spy.shown).toEqual(['b-1'])
  })

  it('offers to start one where nothing has been said, out of the tab order', () => {
    const spy = actions()
    const d = doc(para('The quick brown fox', 'b-1'))
    const [button] = margins(d, [], spy)

    expect(button!.className).toBe('okb-comment-start')
    expect(button!.textContent).toBe('')
    // Named for what it does, by label and as a tooltip for the pointer — and
    // not after the toolbar's "Comment on this block", which every block would
    // then answer to.
    expect(button!.getAttribute('aria-label')).toBe('Start a conversation on this block')
    expect(button!.title).toBe('Start a conversation on this block')
    // One tab stop per block of the page is what this avoids; the toolbar
    // and the block menu are the keyboard's way to the same action.
    expect(button!.tabIndex).toBe(-1)
    button!.dispatchEvent(new Event('click'))
    // The block's own position, one before the widget's.
    expect(spy.started).toEqual([0])
  })

  it('anchors the control on every block, whatever the block holds', () => {
    const d = doc(para('Text', 'b-1'), editorSchema.node('image', { id: 'b-2', media: 'm-1' }))
    // The class the control is positioned against, so no block type falls back
    // to a positioned ancestor further up (main.css).
    expect(marginDecorations(d, new Map(), NO_ACTIONS).find()
      .map(x => (x as unknown as { type: { attrs?: Record<string, unknown> } }).type.attrs)
      .filter(Boolean)).toEqual([{ class: 'okb-margin-host' }, { class: 'okb-margin-host' }])
  })

  it('rides an anchor after a leaf block, which has no inside', () => {
    const spy = actions()
    const d = doc(editorSchema.node('image', { id: 'b-img', media: 'm-1' }))
    const [host] = margins(d, [], spy)

    expect(host!.className).toBe('okb-margin-gap')
    const button = host!.firstElementChild as HTMLElement
    expect(button.className).toBe('okb-comment-start')
    button.dispatchEvent(new Event('click'))
    expect(spy.started).toEqual([0])
  })

  it('offers one on a block that carries no id yet', () => {
    const spy = actions()
    const d = doc(para('Nobody has touched this', null))
    const [button] = margins(d, [], spy)

    expect(button!.className).toBe('okb-comment-start')
    button!.dispatchEvent(new Event('click'))
    // Named by position: the id is minted when the thread is opened.
    expect(spy.started).toEqual([0])
  })
})

/**
 * The badge as a mounted editor draws it. A real view, because what is under
 * test is what ProseMirror does with a key pressed on the widget's own DOM.
 */
describe('the margin badge, mounted', () => {
  const editors: Editor[] = []
  afterEach(() => { editors.splice(0).forEach(editor => editor.destroy()) })

  /** Paragraphs carry the block id the comment model keys on. */
  const IdParagraph = Paragraph.extend({
    addAttributes() {
      return { id: { default: null } }
    },
  })

  it('keeps a keypress on the badge out of the document', () => {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        IdParagraph,
        Text,
        CommentMarks.configure({ threads: () => [thread('b-1', null)] }),
      ],
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', attrs: { id: 'b-1' }, content: [{ type: 'text', text: 'One paragraph' }] }],
      },
    })
    editors.push(editor)
    const badge = editor.view.dom.querySelector<HTMLButtonElement>('.okb-comment-badge')
    expect(badge).not.toBeNull()
    const before = editor.state.doc.toJSON()

    // Enter on the focused badge is the button's press. Reaching the editor's
    // own keymap from there splits the paragraph the badge sits in.
    badge!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }))

    expect(editor.state.doc.toJSON()).toEqual(before)
  })
})

describe('threadAt', () => {
  const d = doc(para('The quick brown fox', 'b-1'))

  it('finds the comment whose passage covers the position', () => {
    // Block starts at 0, its text at 1 — so "quick" covers 5..10.
    const decorations = commentDecorations(d, [thread('b-1', 'quick', 4, 9)])
    expect(threadAt(decorations, 7)).toEqual({ blockId: 'b-1', threadId: 'c-1' })
  })

  it('finds nothing where no passage is highlighted', () => {
    const decorations = commentDecorations(d, [thread('b-1', 'quick', 4, 9)])
    expect(threadAt(decorations, 15)).toBeNull()
  })

  it('ignores the block mark, which covers the whole block', () => {
    const decorations = commentDecorations(d, [thread('b-1', null)])
    expect(threadAt(decorations, 7)).toBeNull()
  })

  it('takes the shortest passage where two comments overlap', () => {
    const wide = { ...thread('b-1', 'quick brown', 4, 15), threadId: 'c-wide' }
    const narrow = { ...thread('b-1', 'quick', 4, 9), threadId: 'c-narrow' }
    const decorations = commentDecorations(d, [wide, narrow])
    expect(threadAt(decorations, 7)?.threadId).toBe('c-narrow')
    // Past the narrow passage only the wide one is left.
    expect(threadAt(decorations, 13)?.threadId).toBe('c-wide')
  })

  it('gives the block and no comment where two equally long passages cover the position', () => {
    const one = { ...thread('b-1', 'quick', 4, 9), threadId: 'c-one' }
    const two = { ...thread('b-1', 'quick', 4, 9), threadId: 'c-two' }
    expect(threadAt(commentDecorations(d, [one, two]), 7)).toEqual({ blockId: 'b-1' })
  })

  it('covers its start and not its end', () => {
    // "quick" covers 5..10 in the document.
    const decorations = commentDecorations(d, [thread('b-1', 'quick', 4, 9)])
    expect(threadAt(decorations, 5)?.threadId).toBe('c-1')
    expect(threadAt(decorations, 10)).toBeNull()
  })
})

/**
 * When the tints are rebuilt. The editor opens before the collaborative
 * document has its content, so the set is first built over an empty document
 * and nothing maps into a tint.
 */
describe('the tints across a change', () => {
  const threads = [thread('b-1', 'quick', 4, 9)]

  /** A state whose document holds `blocks`, with the plugin on it. */
  function withPlugin(...blocks: PMNode[]): EditorState {
    return EditorState.create({
      doc: doc(...blocks),
      schema: editorSchema,
      plugins: [createCommentMarksPlugin(() => threads, () => {})],
    })
  }

  /** The document ranges the plugin currently tints. */
  function passages(state: EditorState): Array<[number, number]> {
    return (commentMarksKey.getState(state) ?? DecorationSet.empty)
      .find()
      .filter(d => (d.spec as { threadId?: string }).threadId)
      .map(d => [d.from, d.to])
  }

  it('tints the passage when the document\'s content arrives', () => {
    const state = withPlugin(para('', null))
    expect(passages(state)).toEqual([])
    const arrives = state.tr
      .replaceWith(0, state.doc.content.size, para('The quick brown fox', 'b-1'))
      .setMeta(ySyncPluginKey, { isChangeOrigin: true })
    // "quick" covers 5..10.
    expect(passages(state.apply(arrives))).toEqual([[5, 10]])
  })

  it('moves a tint with the reader\'s own typing instead of re-resolving it', () => {
    const state = withPlugin(para('The quick brown fox', 'b-1'))
    expect(passages(state)).toEqual([[5, 10]])
    // A character typed inside the passage, whose quote no longer reads back.
    expect(passages(state.apply(state.tr.insertText('!', 7)))).toEqual([[5, 11]])
  })
})

/**
 * The click on a highlighted passage, through a mounted editor: the plugin
 * registers `handleClick`, and what matters is that a click inside the
 * passage reports that comment and a click outside it reports nothing.
 */
describe('clicking a highlighted passage, mounted', () => {
  const editors: Editor[] = []
  afterEach(() => { editors.splice(0).forEach(editor => editor.destroy()) })

  const IdParagraph = Paragraph.extend({
    addAttributes() {
      return { id: { default: null } }
    },
  })

  /** Runs the editor's own click handling at `pos`, as ProseMirror would. */
  function clickAt(editor: Editor, pos: number): void {
    editor.view.someProp('handleClick', handler =>
      handler(editor.view, pos, new MouseEvent('click')))
  }

  function mount(shown: Array<[string, string | undefined]>): Editor {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        Document,
        IdParagraph,
        Text,
        CommentMarks.configure({
          threads: () => [thread('b-1', 'quick', 4, 9)],
          showThreads: (blockId, threadId) => { shown.push([blockId, threadId]) },
        }),
      ],
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', attrs: { id: 'b-1' }, content: [{ type: 'text', text: 'The quick brown fox' }] }],
      },
    })
    editors.push(editor)
    return editor
  }

  it('opens the comment the passage carries', () => {
    const shown: Array<[string, string | undefined]> = []
    // "quick" covers 5..10 in the document.
    clickAt(mount(shown), 7)
    expect(shown).toEqual([['b-1', 'c-1']])
  })

  it('opens nothing when the click is outside every passage', () => {
    const shown: Array<[string, string | undefined]> = []
    clickAt(mount(shown), 15)
    expect(shown).toEqual([])
  })

  it('leaves the document alone, so the caret still lands', () => {
    const editor = mount([])
    const before = editor.state.doc.toJSON()
    clickAt(editor, 7)
    expect(editor.state.doc.toJSON()).toEqual(before)
  })
})

describe('contentOffsetOf', () => {
  it('is the text offset itself for a block that holds nothing but text', () => {
    const node = para('The quick brown fox', 'b-1')
    expect(contentOffsetOf(node, 4)).toBe(4)
    expect(contentOffsetOf(node, 9)).toBe(9)
  })

  it('counts an inline node that carries no characters', () => {
    const node = editorSchema.node('paragraph', { id: 'b-1' }, [
      editorSchema.text('ab'),
      editorSchema.node('hardBreak'),
      editorSchema.text('cd'),
    ])
    // "abcd" as text; the break occupies one position between them.
    expect(contentOffsetOf(node, 2)).toBe(2)
    expect(contentOffsetOf(node, 3)).toBe(4)
  })

  it('clamps past the end of the block rather than pointing outside it', () => {
    expect(contentOffsetOf(para('abc', 'b-1'), 99)).toBe(3)
  })
})

describe('anchorAtSelection', () => {
  function stateWith(d: PMNode, from: number, to: number): EditorState {
    const state = EditorState.create({ doc: d, schema: editorSchema })
    return state.apply(state.tr.setSelection(TextSelection.create(d, from, to)))
  }

  it('reports the selected passage as offsets into the block text', () => {
    const d = doc(para('The quick brown fox', 'b-1'))
    expect(anchorAtSelection(stateWith(d, 5, 10))).toEqual({ from: 4, to: 9, quote: 'quick' })
  })

  it('is null for a caret — a place is not a passage', () => {
    const d = doc(para('The quick brown fox', 'b-1'))
    expect(anchorAtSelection(stateWith(d, 5, 5))).toBeNull()
  })

  it('reports offsets into the text, not into the content, past an inline node', () => {
    const d = doc(editorSchema.node('paragraph', { id: 'b-1' }, [
      editorSchema.text('ab'),
      editorSchema.node('hardBreak'),
      editorSchema.text('cd'),
    ]))
    expect(anchorAtSelection(stateWith(d, 4, 6))).toEqual({ from: 2, to: 4, quote: 'cd' })
  })

  it('takes the part of a cross-block selection that lies in the cursor\'s block', () => {
    // The thread attaches to the block holding the cursor — the same block a
    // sign-off would attach to — so the anchor can only be the part of the
    // selection inside it.
    const d = doc(para('first', 'b-1'), para('second', 'b-2'))
    expect(anchorAtSelection(stateWith(d, 2, 10))).toEqual({ from: 0, to: 2, quote: 'se' })
  })
})

describe('commentRows', () => {
  it('carries the text of the block each thread is on, for the drawer to name it by', () => {
    const d = doc(para('The quick brown fox', 'b-1'))
    expect(commentRows(d, [thread('b-1', null)])[0]).toMatchObject({
      blockId: 'b-1',
      blockText: 'The quick brown fox',
    })
  })

  it('drops a thread whose block has left the document — there is nowhere to send anybody', () => {
    expect(commentRows(doc(para('The quick brown fox', 'b-1')), [thread('b-gone', null)])).toEqual([])
  })

  it('lists a resolved thread too — the drawer keeps it, behind its disclosure', () => {
    const session = new Y.Doc()
    recordCommentMessage(session, 'b-1', 'c-1', 'm-a', { uid: 7, at: AT, text: 'is this right?' })
    recordCommentMessage(session, 'b-1', 'c-1', 'm-r', { uid: 8, at: AT + 1, resolved: true })
    const rows = commentRows(doc(para('The quick brown fox', 'b-1')), readThreads(session))
    expect(rows.map(r => r.resolved)).toEqual([true])
  })
})

describe('markedPassage', () => {
  function stateWith(d: PMNode, from: number, to: number): EditorState {
    const state = EditorState.create({ doc: d, schema: editorSchema })
    return state.apply(state.tr.setSelection(TextSelection.create(d, from, to)))
  }

  it('is the words marked inside the block', () => {
    const d = doc(para('The quick brown fox', 'b-1'))
    expect(markedPassage(stateWith(d, 5, 10), 0)).toEqual({ from: 4, to: 9, quote: 'quick' })
  })

  it('is null for a selection in another block — the thread is not about those words', () => {
    const d = doc(para('first', 'b-1'), para('second', 'b-2'))
    expect(markedPassage(stateWith(d, 8, 12), 0)).toBeNull()
  })

  it('is null for a selection running past the block — that marks blocks, not a passage', () => {
    const d = doc(para('first', 'b-1'), para('second', 'b-2'))
    expect(markedPassage(stateWith(d, 2, 10), 7)).toBeNull()
  })
})

describe('the remembered anchor', () => {
  /**
   * The passage has to survive the toolbar press that collapses it: the
   * comment button is outside `contenteditable`, so focusing it drops the DOM
   * selection and ProseMirror reads it back as a caret.
   */
  function withPlugin(d: PMNode): EditorState {
    return EditorState.create({ doc: d, schema: editorSchema, plugins: [createCommentAnchorPlugin()] })
  }
  function select(state: EditorState, from: number, to: number): EditorState {
    return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)))
  }

  it('keeps the passage when the selection collapses inside the same block', () => {
    const d = doc(para('The quick brown fox', 'b-1'))
    const selected = select(withPlugin(d), 5, 10)
    const collapsed = select(selected, 7, 7)
    expect(anchorAtSelection(collapsed)).toBeNull()
    expect(rememberedAnchor(collapsed, 0)).toEqual({ from: 4, to: 9, quote: 'quick' })
  })

  it('drops it once the cursor is in another block — that comment is about where you are', () => {
    const d = doc(para('first', 'b-1'), para('second', 'b-2'))
    const selected = select(withPlugin(d), 1, 4)
    const elsewhere = select(selected, 9, 9)
    expect(rememberedAnchor(elsewhere, 7)).toBeNull()
    expect(rememberedAnchor(elsewhere, 0)).toBeNull()
  })

  it('holds across the whole-block selection the block menu sets as it opens', () => {
    const d = doc(para('The quick brown fox', 'b-1'))
    const selected = select(withPlugin(d), 5, 10)
    const blockSelected = selected.apply(selected.tr.setSelection(NodeSelection.create(selected.doc, 0)))
    expect(rememberedAnchor(blockSelected, 0)).toEqual({ from: 4, to: 9, quote: 'quick' })
  })

  it('answers nothing for a block that never held a selection', () => {
    const d = doc(para('The quick brown fox', 'b-1'))
    expect(rememberedAnchor(withPlugin(d), 0)).toBeNull()
  })
})

describe('blockAnchor', () => {
  it('names the whole block, so a note opened without a passage still quotes real text', () => {
    expect(blockAnchor({ text: 'Comment target paragraph.' }))
      .toEqual({ from: 0, to: 25, quote: 'Comment target paragraph.' })
  })

  it('is null for an empty block — there are no words to quote', () => {
    expect(blockAnchor({ text: '' })).toBeNull()
  })

  it('resolves to a highlight over the whole block, not a degraded block-level mark', () => {
    const d = doc(para('The quick brown fox', 'b-1'))
    const anchor = blockAnchor({ text: 'The quick brown fox' })!
    const whole = thread('b-1', anchor.quote, anchor.from, anchor.to)
    expect(specs(d, [whole])[1]).toEqual({ class: 'okb-comment-range', 'data-comment-thread': 'c-1' })
    // Block starts at 0, its text at 1 — the highlight spans the whole text.
    expect(ranges(d, [whole])[1]).toEqual([1, 20])
  })
})
