// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import * as Y from 'yjs'
import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import Collaboration from '@tiptap/extension-collaboration'
import { EditorState } from '@tiptap/pm/state'
import type { Node as PMNode } from '@tiptap/pm/model'
import { editorSchema } from '../../server/utils/editor-schema'
import { BlockId } from './nodes/block-id'
import { blocksNeedingIds, createBlockIdPlugin, BlockIdMinter } from './block-id-minter'

function para(text: string, id: string | null): PMNode {
  return editorSchema.node('paragraph', { id }, text ? [editorSchema.text(text)] : [])
}
function doc(...blocks: PMNode[]): PMNode {
  return editorSchema.node('doc', null, blocks)
}

describe('blocksNeedingIds', () => {
  it('finds id-less id-bearing blocks within the given ranges', () => {
    const d = doc(para('a', 'b-1'), para('b', null))
    // Range covering the second paragraph (positions past the first block).
    const found = blocksNeedingIds(d, [[d.child(0).nodeSize, d.content.size]])
    expect(found).toHaveLength(1)
    expect(d.nodeAt(found[0]!.pos)?.textContent).toBe('b')
    expect(found[0]!.replaces).toBeNull()
  })

  it('ignores an id-less block outside the changed ranges', () => {
    const d = doc(para('untouched', null), para('touched', null))
    const found = blocksNeedingIds(d, [[d.child(0).nodeSize, d.content.size]])
    expect(found.map(f => d.nodeAt(f.pos)?.textContent)).toEqual(['touched'])
  })

  it('flags a duplicated id document-wide, keeping the first occurrence', () => {
    // What a block split produces: both halves carry the original's id.
    const d = doc(para('first half', 'b-dup'), para('second half', 'b-dup'))
    // No changed ranges at all — duplicates are not range-limited.
    const found = blocksNeedingIds(d, [])
    expect(found).toHaveLength(1)
    expect(d.nodeAt(found[0]!.pos)?.textContent).toBe('second half')
    expect(found[0]!.replaces).toBe('b-dup')
  })

  it('does not flag distinct ids', () => {
    expect(blocksNeedingIds(doc(para('a', 'b-1'), para('b', 'b-2')), [])).toEqual([])
  })

  it('clamps out-of-range ranges without throwing', () => {
    const d = doc(para('a', null))
    expect(() => blocksNeedingIds(d, [[-5, 9999]])).not.toThrow()
  })
})

describe('the minting plugin (local edit path)', () => {
  function stateWith(...blocks: PMNode[]) {
    return EditorState.create({ schema: editorSchema, doc: doc(...blocks), plugins: [createBlockIdPlugin()] })
  }

  it('mints an id for a touched id-less block', () => {
    let state = stateWith(para('hi', null))
    // Insert 'x' inside the paragraph (position 3 = after 'hi').
    state = state.apply(state.tr.insertText('x', 3))
    expect(state.doc.firstChild!.attrs.id).toMatch(/^b-/)
  })

  it('leaves an already-id-ed block on the id it has', () => {
    let state = stateWith(para('hi', 'b-1'))
    state = state.apply(state.tr.insertText('xyz', 3))
    expect(state.doc.firstChild!.attrs.id).toBe('b-1')
  })

  it('mints nothing when the doc did not change', () => {
    let state = stateWith(para('hi', null))
    state = state.apply(state.tr.setMeta('noop', true))
    expect(state.doc.firstChild!.attrs.id).toBeNull()
  })

  it('re-mints the duplicate id a block split leaves behind', () => {
    // splitBlock copies the node's attrs onto the new half, id included.
    let state = stateWith(para('abcdef', 'b-1'))
    state = state.apply(state.tr.split(4))
    const ids = state.doc.children.map(n => n.attrs.id as string)
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe('b-1')
    expect(ids[1]).toMatch(/^b-/)
    expect(new Set(ids).size).toBe(2)
  })

  it('mints for the container itself, never inside it', () => {
    const cell = (text: string) =>
      editorSchema.node('tableCell', null, [editorSchema.node('paragraph', { id: null }, [editorSchema.text(text)])])
    const table = editorSchema.node('table', null, [
      editorSchema.node('tableRow', null, [cell('Name'), cell('Role')]),
    ])
    const list = editorSchema.node('bulletList', null, [
      editorSchema.node('listItem', null, [editorSchema.node('paragraph', { id: null }, [editorSchema.text('item')])]),
    ])

    let state = EditorState.create({
      schema: editorSchema,
      doc: doc(table, list),
      plugins: [createBlockIdPlugin()],
    })
    // Type into the first table cell.
    state = state.apply(state.tr.insertText('!', 4))

    const nestedIds: unknown[] = []
    state.doc.descendants((node, pos) => {
      if (pos > 0 && 'id' in node.attrs) nestedIds.push(node.attrs.id)
      return true
    })
    expect(nestedIds.every(id => id === null || id === undefined)).toBe(true)
    // The edited container gains its own id (it rides the ::block wrapper on
    // serialize); the untouched list gets nothing.
    expect(state.doc.child(0).attrs.id).toMatch(/^b-/)
    expect(state.doc.child(1).attrs.id).toBeNull()
  })
})

/**
 * A mint rides in the Y update its own keystroke writes: y-tiptap reads one
 * `addToHistory` off the last document change in a dispatch and applies it to
 * the whole update, so taking the mint out of the history takes the keystroke
 * with it and the first edit to an id-less block cannot be undone.
 */
describe('a minted id stays in the undo history', () => {
  const editors: Editor[] = []
  afterEach(() => { editors.splice(0).forEach(editor => editor.destroy()) })

  it('undoes the first edit to a block the minter has to give an id', () => {
    const ydoc = new Y.Doc()
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [Document, Paragraph, Text, BlockId, BlockIdMinter, Collaboration.configure({ document: ydoc })],
    })
    editors.push(editor)

    // A paragraph arriving over the wire. Markdown without `{#id}` carries none.
    const source = new Y.Doc()
    const paragraph = new Y.XmlElement('paragraph')
    paragraph.insert(0, [new Y.XmlText('One.')])
    source.getXmlFragment('default').insert(0, [paragraph])
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(source))

    editor.commands.focus('end')
    for (const char of ' two') editor.commands.insertContent(char)
    expect(editor.state.doc.firstChild?.attrs.id, 'the minter gave the block an id').toMatch(/^b-/)

    // Every typed character, the one that minted the id included.
    while (editor.commands.undo());
    expect(editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n')).toBe('One.')
  })
})
