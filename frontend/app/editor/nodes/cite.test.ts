// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { Editor } from '@tiptap/core'
import type { JSONContent } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { OkbCite } from './cite'
import { parseMarkdownToDoc, parseMarkdownToJson, serializeDocToMarkdown } from '~/comark/markdown-engine'

/** The node one citation parses to, from the whole editor engine, with the schema's defaults filled in. */
async function node(markdown: string) {
  return ((await parseMarkdownToDoc(markdown)).toJSON() as JSONContent).content?.[0]?.content?.find(child => child.type === 'citation')
}

describe('a citation in markdown', () => {
  it('reads the block it names and the version it was made against', async () => {
    expect(await node('Derived. :citation{nid="42" block="b-4f2a" v="e0ff367d5ce8"}'))
      .toEqual({ type: 'citation', attrs: { nid: 42, block: 'b-4f2a', v: 'e0ff367d5ce8', url: null } })
  })

  it('reads an external source', async () => {
    expect(await node('Derived. :citation{url="https://example.org/paper"}'))
      .toEqual({ type: 'citation', attrs: { nid: null, block: null, v: null, url: 'https://example.org/paper' } })
  })

  it('is written back in one spelling, whatever quoting it was read in', async () => {
    const unquoted = await parseMarkdownToJson('A :citation{nid=42 block=b-4f2a v=e0ff367d5ce8} b')
    expect(await serializeDocToMarkdown(unquoted))
      .toBe('A :citation{nid="42" block="b-4f2a" v="e0ff367d5ce8"} b')
  })

  it('leaves a component naming no source as the words it was written as', async () => {
    expect(await node('A :citation{nid="nope"} citation.')).toBeUndefined()
  })

  it('writes no version without a block to hang it on', async () => {
    const page = { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'A ' },
      { type: 'citation', attrs: { nid: 42, block: null, v: 'e0ff367d5ce8', url: null } },
    ] }] }
    expect(await serializeDocToMarkdown(page)).toBe('A :citation{nid="42"}')
  })
})

describe('pasting a rendered citation', () => {
  it('keeps its target', () => {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [Document, Paragraph, Text, OkbCite],
      content: '<p>See <span data-type="citation" data-nid="42" data-block="b-4f2a" data-v="e0ff367d5ce8"></span></p>',
    })
    const json = editor.getJSON()
    editor.destroy()
    expect(json.content?.[0]?.content?.[1])
      .toEqual({ type: 'citation', attrs: { nid: 42, block: 'b-4f2a', v: 'e0ff367d5ce8', url: null } })
  })
})
