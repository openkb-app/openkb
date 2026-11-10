// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { Editor } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { TextSelection } from '@tiptap/pm/state'
import { yUndoPluginKey } from '@tiptap/y-tiptap'
import { BlockId } from './nodes/block-id'
import { CollabHistory } from './collab-history'
import { SelectionKeydownSync } from './selection-sync'

/**
 * Two people on one page: two editors, each on its own Y.Doc, synced the way
 * the collaboration server relays updates between browsers.
 *
 * `it.fails` marks an open upstream bug: the test asserts the correct
 * behaviour and turns red once a y-tiptap release fixes it. Then drop the marker.
 */

// doc: <p>one</p><p>two</p> — 0 <p> 1 o 2 n 3 e 4 </p> 5 <p> 6 t 7 w 8 o 9
const PARA_ONE = 1
const PARA_TWO = 6
const RELAYED = 'relayed'

const editors: Editor[] = []
afterEach(() => {
  editors.splice(0).forEach(editor => editor.destroy())
  document.body.innerHTML = ''
})

/** Mounts an editor with the page editor's collaboration extensions on `ydoc`. */
function mountEditorOnDocument(ydoc: Y.Doc): Editor {
  const element = document.createElement('div')
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: [Document, Paragraph, Text, BlockId, SelectionKeydownSync, CollabHistory, Collaboration.configure({ document: ydoc })],
  })
  editors.push(editor)
  return editor
}

/** Mounts two editors whose documents relay every update to each other, seeded with `html`. */
function mountTwoPeersWithContent(html: string): [Editor, Editor] {
  const mine = new Y.Doc()
  const theirs = new Y.Doc()
  mine.on('update', (update: Uint8Array, origin: unknown) => origin !== RELAYED && Y.applyUpdate(theirs, update, RELAYED))
  theirs.on('update', (update: Uint8Array, origin: unknown) => origin !== RELAYED && Y.applyUpdate(mine, update, RELAYED))
  const me = mountEditorOnDocument(mine)
  const peer = mountEditorOnDocument(theirs)
  me.commands.setContent(html)
  yUndoPluginKey.getState(me.state)!.undoManager.stopCapturing()
  return [me, peer]
}

/** Puts the editor's selection from `anchor` to `head`. */
function selectRange(editor: Editor, anchor: number, head = anchor): void {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, anchor, head)))
}

/** Types one key at the editor's selection as its own transaction. */
function typeKey(editor: Editor, key: string): void {
  editor.view.dispatch(editor.state.tr.insertText(key))
}

describe('two people editing one page', () => {
  // https://github.com/ueberdosis/tiptap/issues/8611
  it.fails('keeps my caret behind my text while the peer types earlier in the same paragraph', () => {
    const [me, peer] = mountTwoPeersWithContent('<p id="b-1">one</p>')
    selectRange(me, PARA_ONE + 3)
    selectRange(peer, PARA_ONE)

    for (const key of 'two') {
      typeKey(me, key)
      typeKey(peer, 'X')
    }

    expect(me.state.doc.textContent).toBe('XXXonetwo')
    expect(peer.state.doc.textContent).toBe('XXXonetwo')
    expect(me.state.selection.head).toBe(PARA_ONE + 9)
  })

  // https://github.com/ueberdosis/tiptap/issues/8611
  it.fails('keeps my range selection around text the peer types into', () => {
    const [me, peer] = mountTwoPeersWithContent('<p id="b-1">one</p>')
    selectRange(me, PARA_ONE, PARA_ONE + 3)
    selectRange(peer, PARA_ONE + 1)

    typeKey(peer, 'X')

    expect(me.state.doc.textContent).toBe('oXne')
    expect([me.state.selection.anchor, me.state.selection.head]).toEqual([PARA_ONE, PARA_ONE + 4])
  })

  it('moves my caret with its paragraph when the peer moves the paragraph', () => {
    const [me, peer] = mountTwoPeersWithContent('<p id="b-1">one</p><p id="b-2">two</p>')
    selectRange(me, PARA_TWO + 2)

    const second = peer.state.doc.child(1)
    peer.view.dispatch(peer.state.tr.delete(PARA_TWO - 1, PARA_TWO - 1 + second.nodeSize).insert(0, second))

    expect(me.state.doc.textContent).toBe('twoone')
    expect(me.state.selection.head).toBe(PARA_ONE + 2)
  })

  // https://github.com/ueberdosis/tiptap/issues/8715
  it.fails('undoes my typed word in one step while the peer types', () => {
    const [me, peer] = mountTwoPeersWithContent('<p id="b-1">Mine</p><p id="b-2">Theirs</p>')
    selectRange(me, PARA_ONE + 4)
    selectRange(peer, PARA_ONE + 6)

    for (const key of ' word') {
      typeKey(me, key)
      typeKey(peer, 'x')
      // The peer's caret update: a transaction that changes no content.
      me.view.dispatch(me.state.tr.setMeta('peerCaret', true))
    }
    expect(me.getText()).toBe('Mine word\n\nxxxxxTheirs')

    me.commands.undo()

    expect(me.getText()).toBe('Mine\n\nxxxxxTheirs')
  })

  it('puts my caret behind the redone text after undo and redo', () => {
    const [me] = mountTwoPeersWithContent('<p id="b-1">Mine</p><p id="b-2">Theirs</p>')
    selectRange(me, PARA_ONE + 4)

    for (const key of ' tail') typeKey(me, key)
    me.commands.undo()
    me.commands.redo()

    expect(me.getText()).toBe('Mine tail\n\nTheirs')
    expect(me.state.selection.head).toBe(PARA_ONE + 9)
  })
})
