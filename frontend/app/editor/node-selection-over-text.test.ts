// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import * as Y from 'yjs'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { buildCommitSchemaExtensions } from '~~/server/utils/editor-schema'
import { parseMarkdownToJson } from '~/comark/markdown-engine'
import { NodeSelectionOverTextToCaret } from './node-selection-over-text'

let editor: Editor
let peer: Editor

/** The position of the first `type` node. */
function findFirstNodePosition(doc: Editor['state']['doc'], type: string): number {
  let at = -1
  doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === type) at = pos
  })
  return at
}

afterEach(() => {
  peer?.destroy()
  editor?.destroy()
})

describe('NodeSelectionOverTextToCaret', () => {
  it('leaves a caret where a co-editor deleted the selected page link', async () => {
    const ours = new Y.Doc()
    const theirs = new Y.Doc()
    ours.on('update', (update: Uint8Array, origin: unknown) => origin !== theirs && Y.applyUpdate(theirs, update, ours))
    theirs.on('update', (update: Uint8Array, origin: unknown) => origin !== ours && Y.applyUpdate(ours, update, theirs))
    peer = new Editor({ extensions: [...buildCommitSchemaExtensions(), Collaboration.configure({ document: theirs })] })
    peer.commands.setContent(await parseMarkdownToJson('Intro.\n\nGone see :doc[Target]{nid="5"} today.\n'))
    editor = new Editor({ extensions: [...buildCommitSchemaExtensions(), Collaboration.configure({ document: ours }), NodeSelectionOverTextToCaret] })
    const at = findFirstNodePosition(editor.state.doc, 'docLink')
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, at)))

    peer.chain().setNodeSelection(findFirstNodePosition(peer.state.doc, 'docLink')).deleteSelection().run()

    expect(findFirstNodePosition(editor.state.doc, 'docLink')).toBe(-1)
    expect(editor.state.selection).toBeInstanceOf(TextSelection)
    expect(editor.state.selection.empty).toBe(true)
    expect(editor.state.selection.from).toBe(at)
  })
})
