// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { Editor } from '@tiptap/core'
import { buildCommitSchemaExtensions } from '~~/server/utils/editor-schema'
import { parseMarkdownToJson, serializeDocToMarkdown } from '~/comark/markdown-engine'
import { citeTarget } from '#shared/utils/citations'
import { CaretMemory, caretInBlock, reciteInBlock } from './cite-insert'

describe('the caret a node selection replaced', () => {
  /** Two paragraphs, with the caret inside the second one. */
  async function twoBlocks() {
    return new Editor({
      extensions: [...buildCommitSchemaExtensions(), CaretMemory],
      content: await parseMarkdownToJson('First block.\n\nSecond block.\n'),
    })
  }

  it('is where the author was typing, once the block menu selects the block', async () => {
    const editor = await twoBlocks()
    const second = editor.state.doc.child(0).nodeSize
    editor.commands.setTextSelection(second + 4)
    editor.commands.setNodeSelection(second)

    expect(caretInBlock(editor.state, second)).toBe(second + 4)
    editor.destroy()
  })

  it('is not offered for a block the caret was not in', async () => {
    const editor = await twoBlocks()
    const second = editor.state.doc.child(0).nodeSize
    editor.commands.setTextSelection(2)
    editor.commands.setNodeSelection(second)

    expect(caretInBlock(editor.state, second)).toBeNull()
    editor.destroy()
  })
})

describe('re-citing a source the block already names', () => {
  it('advances that node rather than adding another', async () => {
    const editor = new Editor({
      extensions: buildCommitSchemaExtensions(),
      content: await parseMarkdownToJson(
        'Derived. :citation{nid="42" block="b-a" v="aaaaaaaaaaaa"} and more.',
      ),
    })
    editor.commands.setTextSelection(2)
    const target = citeTarget({ nid: '42', block: 'b-a', v: 'bbbbbbbbbbbb' })!

    expect(reciteInBlock(editor, target, 'bbbbbbbbbbbb')).toBe(true)
    expect(await serializeDocToMarkdown(editor.getJSON()))
      .toBe('Derived. :citation{nid="42" block="b-a" v="bbbbbbbbbbbb"} and more.')
    editor.destroy()
  })

  it('leaves a source the block does not name to the caller', async () => {
    const editor = new Editor({
      extensions: buildCommitSchemaExtensions(),
      content: await parseMarkdownToJson('Derived. :citation{nid="42" block="b-a" v="aaaaaaaaaaaa"}'),
    })
    editor.commands.setTextSelection(2)
    expect(reciteInBlock(editor, citeTarget({ nid: '7', block: 'b-b' })!, null)).toBe(false)
    editor.destroy()
  })
})
