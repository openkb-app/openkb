// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import Collaboration from '@tiptap/extension-collaboration'
import * as Y from 'yjs'
import { yUndoPluginKey } from '@tiptap/y-tiptap'
import { CollabHistory } from './collab-history'

let editor: Editor

/** Mounts `html`, then types ` Typed.` as its own undo step. */
function mountTyped(html: string): void {
  editor = new Editor({ element: document.createElement('div'), extensions: [Document, Paragraph, Text, Collaboration.configure({ document: new Y.Doc() }), CollabHistory] })
  editor.commands.setContent(html)
  yUndoPluginKey.getState(editor.state)!.undoManager.stopCapturing()
  editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' Typed.')
}

/** Presses `key` with Mod held, through the editor's keymaps; true when one handled it. */
function press(key: string, init: KeyboardEventInit = {}): boolean {
  const mod = /Mac|iP(hone|[oa]d)/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }
  const event = new KeyboardEvent('keydown', { key, keyCode: key.toUpperCase().charCodeAt(0), ...mod, ...init })
  return Boolean(editor.view.someProp('handleKeyDown', handle => handle(editor.view, event)))
}

afterEach(() => editor?.destroy())

describe('the redo keys', () => {
  // A lowercase `z` with Shift is what Caps Lock and Playwright send.
  it.each([
    ['Shift-Mod-z', 'Z'],
    ['Shift-Mod-z, lowercase key', 'z'],
    ['Mod-y', 'y'],
  ])('%s with nothing to redo keeps the text and is handled', (_name, key) => {
    mountTyped('<p>First.</p>')
    expect(editor.getText()).toBe('First. Typed.')
    expect(press(key, { shiftKey: key !== 'y' })).toBe(true)
    expect(editor.getText()).toBe('First. Typed.')
  })

  it('Shift-Mod-z with a lowercase key redoes an undo', () => {
    mountTyped('<p>First.</p>')
    expect(press('z')).toBe(true)
    expect(editor.getText()).toBe('First.')
    expect(press('z', { shiftKey: true })).toBe(true)
    expect(editor.getText()).toBe('First. Typed.')
  })
})
