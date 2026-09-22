// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { Editor } from '@tiptap/core'
import { buildCommitSchemaExtensions } from '~~/server/utils/editor-schema'
import { parseMarkdownToJson, serializeDocToMarkdown } from '~/comark/markdown-engine'
import { citeTarget } from '#shared/utils/citations'
import { recordCiteInsert, reciteInBlock, takeCiteInsert } from './cite-insert'

describe('what the picker was opened for', () => {
  it('is read once, at the position it was recorded against', () => {
    recordCiteInsert(12)
    expect(takeCiteInsert(12)).toBe(true)
    expect(takeCiteInsert(12)).toBe(false)
  })

  it('is dropped where an abandoned `[[` left the position behind', () => {
    recordCiteInsert(12)
    expect(takeCiteInsert(40)).toBe(false)
  })
})

describe('re-citing a source the block already names', () => {
  it('advances that node rather than adding another', () => {
    const editor = new Editor({
      extensions: buildCommitSchemaExtensions(),
      content: parseMarkdownToJson(
        'Derived. :citation{nid="42" block="b-a" v="aaaaaaaaaaaa"} and more.',
      ),
    })
    editor.commands.setTextSelection(2)
    const target = citeTarget({ nid: '42', block: 'b-a', v: 'bbbbbbbbbbbb' })!

    expect(reciteInBlock(editor, target, 'bbbbbbbbbbbb')).toBe(true)
    expect(serializeDocToMarkdown(editor.getJSON()))
      .toBe('Derived. :citation{nid="42" block="b-a" v="bbbbbbbbbbbb"} and more.')
    editor.destroy()
  })

  it('leaves a source the block does not name to the caller', () => {
    const editor = new Editor({
      extensions: buildCommitSchemaExtensions(),
      content: parseMarkdownToJson('Derived. :citation{nid="42" block="b-a" v="aaaaaaaaaaaa"}'),
    })
    editor.commands.setTextSelection(2)
    expect(reciteInBlock(editor, citeTarget({ nid: '7', block: 'b-b' })!, null)).toBe(false)
    editor.destroy()
  })
})
