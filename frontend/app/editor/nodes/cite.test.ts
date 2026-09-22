// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Text from '@tiptap/extension-text'
import { OkbCite } from './cite'
import { OkbParagraph } from './markdown-overrides'
import { parseMarkdownToJson, serializeDocToMarkdown } from '~/comark/markdown-engine'

/** The node one citation parses to, from the whole editor engine. */
function node(markdown: string) {
  return parseMarkdownToJson(markdown).content?.[0]?.content?.find(child => child.type === 'citation')
}

describe('a citation in markdown', () => {
  it('reads the block it names and the version it was made against', () => {
    expect(node('Derived. :citation{nid="42" block="b-4f2a" v="e0ff367d5ce8"}'))
      .toEqual({ type: 'citation', attrs: { nid: 42, block: 'b-4f2a', v: 'e0ff367d5ce8', url: null } })
  })

  it('reads an external source', () => {
    expect(node('Derived. :citation{url="https://example.org/paper"}'))
      .toEqual({ type: 'citation', attrs: { nid: null, block: null, v: null, url: 'https://example.org/paper' } })
  })

  it('is written back in one spelling, whatever quoting it was read in', () => {
    const unquoted = parseMarkdownToJson('A :citation{nid=42 block=b-4f2a v=e0ff367d5ce8} b')
    expect(serializeDocToMarkdown(unquoted))
      .toBe('A :citation{nid="42" block="b-4f2a" v="e0ff367d5ce8"} b')
  })

  it('leaves a component naming no source as the words it was written as', () => {
    expect(node('A :citation{nid="nope"} citation.')).toBeUndefined()
  })

  it('writes no version without a block to hang it on', () => {
    const page = { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'citation', attrs: { nid: 42, block: null, v: 'e0ff367d5ce8', url: null } },
    ] }] }
    expect(serializeDocToMarkdown(page)).toBe(':citation{nid="42"}')
  })
})

describe('pasting a rendered citation', () => {
  it('keeps its target', () => {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [Document, OkbParagraph, Text, OkbCite],
      content: '<p>See <span data-type="citation" data-nid="42" data-block="b-4f2a" data-v="e0ff367d5ce8"></span></p>',
    })
    const json = editor.getJSON()
    editor.destroy()
    expect(json.content?.[0]?.content?.[1])
      .toEqual({ type: 'citation', attrs: { nid: 42, block: 'b-4f2a', v: 'e0ff367d5ce8', url: null } })
  })
})
