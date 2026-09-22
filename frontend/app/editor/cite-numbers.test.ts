import { describe, it, expect } from 'vitest'
import { editorSchema } from '~~/server/utils/editor-schema'
import { parseMarkdownToDoc } from '~/comark/markdown-engine'
import { citeNumbers } from './cite-numbers'

/** The numbers the decoration would draw, in document order. */
function numbers(markdown: string): number[] {
  return [...citeNumbers(parseMarkdownToDoc(markdown)).values()]
}

describe('numbering the editor’s citation chips', () => {
  it('counts distinct targets in document order', () => {
    expect(numbers([
      'One. :citation{nid="42" block="b-a" v="aaaaaaaaaaaa"}',
      '',
      'Two. :citation{nid="7" block="b-b" v="bbbbbbbbbbbb"}',
    ].join('\n'))).toEqual([1, 2])
  })

  it('gives one target one number however often it is cited', () => {
    expect(numbers(
      'A :citation{nid="42" block="b-a" v="aaaaaaaaaaaa"} and :citation{nid="42" block="b-a" v="zzzzzzzzzzzz"}',
    )).toEqual([1, 1])
  })

  it('numbers an external source beside a page one', () => {
    expect(numbers(
      'A :citation{url="https://example.org/"} b :citation{nid="42" block="b-a" v="aaaaaaaaaaaa"}',
    )).toEqual([1, 2])
  })

  it('has nothing to number in a document that cites nothing', () => {
    expect(citeNumbers(editorSchema.nodeFromJSON({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Plain.' }] }],
    })).size).toBe(0)
  })
})
