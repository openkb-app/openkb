// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import * as Y from 'yjs'
import { Editor, Extension } from '@tiptap/core'
import type { AnyExtension } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { Plugin, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { readUnreadSelection, SelectionKeydownSync } from './selection-sync'

/**
 * happy-dom fires `selectionchange` synchronously, so PM would read a DOM
 * selection the moment it is set. The tests hold that event back to keep the
 * move unread, as a browser does until its next task.
 */

// doc: <p>one</p><p>two</p> — 0 <p> 1 o 2 n 3 e 4 </p> 5 <p> 6 t 7 w 8 o 9
const PARA_ONE = 1
const PARA_TWO = 6

const editors: Editor[] = []
afterEach(() => {
  editors.splice(0).forEach(editor => editor.destroy())
  document.body.innerHTML = ''
})

function mount(ydoc?: Y.Doc, extra: AnyExtension[] = []): EditorView {
  const element = document.createElement('div')
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: [
      Document, Paragraph, Text, SelectionKeydownSync, ...extra,
      ...(ydoc ? [Collaboration.configure({ document: ydoc })] : []),
    ],
    ...(ydoc ? {} : { content: '<p>one</p><p>two</p>' }),
  })
  editors.push(editor)
  editor.view.focus()
  // happy-dom delivers mutation records late; a browser has read focus's by now.
  ;(editor.view as unknown as { domObserver: { flush(): void } }).domObserver.flush()
  return editor.view
}

function caretAt(view: EditorView, pos: number): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
}

/** Moves the DOM caret the way a caret key does, without PM reading it. */
function pressCaretKey(view: EditorView, paragraph: number, offset: number): void {
  view.dom.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'End', keyCode: 35 }))
  moveDOMCaret(view, paragraph, offset)
}

/** Moves the DOM caret without PM reading it. */
function moveDOMCaret(view: EditorView, paragraph: number, offset: number): void {
  const text = view.dom.querySelectorAll('p')[paragraph]!.firstChild!
  const holdBack = (event: Event) => event.stopImmediatePropagation()
  window.addEventListener('selectionchange', holdBack, true)
  document.getSelection()!.collapse(text, offset)
  window.removeEventListener('selectionchange', holdBack, true)
}

describe('an unread caret move', () => {
  it('leaves the selection alone when nothing is unread', () => {
    const view = mount()
    caretAt(view, PARA_TWO + 1)
    const selection = view.state.selection

    const tr = view.state.tr.setMeta('probe', true)
    view.dispatch(tr)

    expect(view.state.selection).toBe(selection)
  })

  it('survives a transaction changing the document', () => {
    const view = mount()
    caretAt(view, PARA_ONE)

    pressCaretKey(view, 1, 1)
    view.dispatch(view.state.tr.insertText('XY', PARA_ONE))

    expect(view.state.selection.head).toBe(PARA_TWO + 1 + 2)
  })

  it('survives a transaction changing nothing but meta', () => {
    const view = mount()
    caretAt(view, PARA_ONE)

    pressCaretKey(view, 1, 1)
    view.dispatch(view.state.tr.setMeta('probe', true))

    expect(view.state.selection.head).toBe(PARA_TWO + 1)
  })

  it('leaves a DOM caret no input placed to PM', () => {
    const view = mount()
    caretAt(view, PARA_ONE)

    moveDOMCaret(view, 1, 1)
    view.dispatch(view.state.tr.setMeta('probe', true))

    expect(view.state.selection.head).toBe(PARA_ONE)
  })

  it('yields to a transaction setting its own selection', () => {
    const view = mount()
    caretAt(view, PARA_ONE)

    pressCaretKey(view, 1, 1)
    caretAt(view, PARA_ONE + 2)

    expect(view.state.selection.head).toBe(PARA_ONE + 2)
  })

  it('drops a transaction the read made stale', () => {
    // Appends text when the selection moves into paragraph two.
    const appendOnMove = Extension.create({
      name: 'appendOnMove',
      addProseMirrorPlugins: () => [new Plugin({
        appendTransaction: (trs, old, state) =>
          trs.some(tr => tr.selectionSet) && old.selection.head < PARA_TWO && state.selection.head > PARA_TWO
            ? state.tr.insertText('!', state.doc.content.size - 1)
            : null,
      })],
    })
    const view = mount(undefined, [appendOnMove])
    caretAt(view, PARA_ONE)

    pressCaretKey(view, 1, 1)
    expect(() => view.dispatch(view.state.tr.insertText('XY', PARA_ONE))).not.toThrow()

    expect(view.state.doc.textContent).toBe('onetwo!')
    expect(view.state.selection.head).toBe(PARA_TWO + 1)
  })

  it('reads pending DOM mutations after the current code, not in it', async () => {
    const view = mount()
    caretAt(view, PARA_ONE)
    // Lets PM's own delayed flush from the caret dispatch run first.
    await new Promise(resolve => setTimeout(resolve, 50))

    pressCaretKey(view, 1, 1)
    view.dom.querySelectorAll('p')[0]!.firstChild!.appendData('!')
    readUnreadSelection(view)

    expect(view.state.doc.textContent).toBe('onetwo')
    expect(view.state.selection.head).toBe(PARA_ONE)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(view.state.doc.textContent).toBe('one!two')
  })

  it('leaves the selection alone while composing', () => {
    const view = mount()
    caretAt(view, PARA_ONE)

    pressCaretKey(view, 1, 1)
    ;(view as unknown as { input: { composing: boolean } }).input.composing = true
    view.dispatch(view.state.tr.setMeta('probe', true))

    expect(view.state.selection.head).toBe(PARA_ONE)
  })

  it('forgets the key press on blur', () => {
    const view = mount()
    caretAt(view, PARA_ONE)

    view.dom.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'End', keyCode: 35 }))
    view.dom.dispatchEvent(new FocusEvent('blur'))
    moveDOMCaret(view, 1, 1)
    view.dispatch(view.state.tr.setMeta('probe', true))

    expect(view.state.selection.head).toBe(PARA_ONE)
  })

  it('survives a remote update replacing the document', () => {
    const ydoc = new Y.Doc()
    const view = mount(ydoc)
    const fragment = ydoc.getXmlFragment('default')
    ydoc.transact(() => {
      for (const text of ['one', 'two']) {
        const paragraph = new Y.XmlElement('paragraph')
        paragraph.insert(0, [new Y.XmlText(text)])
        fragment.push([paragraph])
      }
    }, 'peer')
    caretAt(view, PARA_ONE)

    pressCaretKey(view, 1, 1)
    ydoc.transact(() => ((fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(0, 'XY'), 'peer')

    expect(view.state.doc.textContent).toBe('XYonetwo')
    expect(view.state.selection.head).toBe(PARA_TWO + 1 + 2)
  })
})
