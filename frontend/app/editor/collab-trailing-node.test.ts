// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import * as Y from 'yjs'
import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import CodeBlock from '@tiptap/extension-code-block'
import Collaboration from '@tiptap/extension-collaboration'
import { TrailingNode } from '@tiptap/extensions'
import { redo, undo, yDocToProsemirrorJSON, yUndoPluginKey } from '@tiptap/y-tiptap'
import type { AnyExtension } from '@tiptap/core'
import { CollabTrailingNode } from './collab-trailing-node'
import { BlockId } from './nodes/block-id'
import { BlockIdMinter } from './block-id-minter'
import { OkbImage } from './nodes/image'
import { serializeDocToMarkdown } from '~/comark/markdown-engine'

/** A page whose body ends in a code block or an image: what loading it does to undo and redo. */

const editors: Editor[] = []
afterEach(() => { editors.splice(0).forEach(editor => editor.destroy()) })

/** The last block of a saved page, and how the Y body lists it. */
const ENDINGS = [
  ['a code block', 'codeBlock:code', () => {
    const code = new Y.XmlElement('codeBlock')
    code.insert(0, [new Y.XmlText('code')])
    return code
  }],
  ['an image', 'image:', () => {
    const image = new Y.XmlElement('image')
    image.setAttribute('file', '66666666-7777-4888-9999-000000000000')
    return image
  }],
] as const

/** A saved page: a paragraph, then `ending`. */
function savedPage(ending: () => Y.XmlElement): Uint8Array {
  const source = new Y.Doc()
  const paragraph = new Y.XmlElement('paragraph')
  paragraph.insert(0, [new Y.XmlText('intro')])
  source.getXmlFragment('default').insert(0, [paragraph, ending()])
  return Y.encodeStateAsUpdate(source)
}

function mount(ydoc: Y.Doc, trailingNode: AnyExtension): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [Document, Paragraph, Text, CodeBlock, OkbImage, BlockId, BlockIdMinter, trailingNode, Collaboration.configure({ document: ydoc })],
  })
  editors.push(editor)
  return editor
}

/** The Y body, block ids left out. */
const yBody = (ydoc: Y.Doc) => ydoc.getXmlFragment('default').toString().replace(/ id="[^"]*"/g, '')

/** The Y body's blocks: type and text. */
const yBlocks = (ydoc: Y.Doc) => ydoc.getXmlFragment('default').toArray().map(block => `${(block as Y.XmlElement).nodeName}:${(block as Y.XmlElement).toArray().join('')}`)

/** The markdown a save writes for the Y body. */
const markdown = (ydoc: Y.Doc) => serializeDocToMarkdown(yDocToProsemirrorJSON(ydoc, 'default'))

const undoManager = (editor: Editor) => (yUndoPluginKey.getState(editor.state) as { undoManager: Y.UndoManager }).undoManager

/** Type after "intro", undo, then let a selection change through. */
function typeAndUndo(editor: Editor): void {
  editor.commands.insertContentAt(6, ' typed')
  expect(editor.state.doc.firstChild!.textContent).toBe('intro typed')
  undo(editor.state)
  expect(editor.state.doc.firstChild!.textContent).toBe('intro')
  editor.commands.setTextSelection(3)
}

for (const [ending, listed, block] of ENDINGS) {
  describe(`the trailing paragraph after ${ending} ending the page`, () => {
    for (const [name, load] of [
      ['arriving over the wire', (ydoc: Y.Doc, trailingNode: AnyExtension) => {
        const editor = mount(ydoc, trailingNode)
        Y.applyUpdate(ydoc, savedPage(block))
        return editor
      }],
      ['already in Y at mount', (ydoc: Y.Doc, trailingNode: AnyExtension) => {
        Y.applyUpdate(ydoc, savedPage(block))
        return mount(ydoc, trailingNode)
      }],
    ] as const) {
      describe(name, () => {
        it('is written to Y at load, out of the undo history', () => {
          const ydoc = new Y.Doc()
          const editor = load(ydoc, CollabTrailingNode)

          expect(yBlocks(ydoc)).toEqual(['paragraph:intro', listed, 'paragraph:'])
          expect(undoManager(editor).undoStack).toHaveLength(0)
        })

        it('leaves the markdown a save writes unchanged', async () => {
          const saved = new Y.Doc()
          Y.applyUpdate(saved, savedPage(block))
          const ydoc = new Y.Doc()
          load(ydoc, CollabTrailingNode)

          expect(await markdown(ydoc)).toBe(await markdown(saved))
        })

        it('leaves redo working after an undo', () => {
          const editor = load(new Y.Doc(), CollabTrailingNode)

          typeAndUndo(editor)
          expect(undoManager(editor).redoStack).toHaveLength(1)
          redo(editor.state)

          expect(editor.state.doc.firstChild!.textContent).toBe('intro typed')
          expect(editor.state.doc.childCount).toBe(3)
        })

        it('clears the redo stack with TipTap\'s own trailing node', () => {
          const editor = load(new Y.Doc(), TrailingNode)

          typeAndUndo(editor)

          expect(undoManager(editor).redoStack).toHaveLength(0)
        })
      })
    }
  })
}

describe('the trailing paragraph after a local edit', () => {
  it('stays in the undo step of a local edit that ends the page in a code block', () => {
    const ydoc = new Y.Doc()
    const editor = mount(ydoc, CollabTrailingNode)
    editor.commands.setContent('<p>intro</p>')
    undoManager(editor).stopCapturing()

    editor.commands.insertContentAt(editor.state.doc.content.size, '<pre><code>code</code></pre>')
    expect(yBody(ydoc)).toBe('<paragraph>intro</paragraph><codeblock>code</codeblock><paragraph></paragraph>')
    undo(editor.state)

    expect(yBody(ydoc)).toBe('<paragraph>intro</paragraph>')
  })
})
