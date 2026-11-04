// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Link from '@tiptap/extension-link'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { OkbDocLink } from './doc-link'

describe('pasting a rendered document link', () => {
  function parse(html: string) {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [Document, Paragraph, Text, Link.configure({ openOnClick: false }), OkbDocLink],
      content: html,
    })
    const json = editor.getJSON()
    editor.destroy()
    return json.content?.[0]?.content?.[0]
  }

  it('keeps the target when the read page’s anchor is pasted', () => {
    // The link mark matches `a[href]` too; the identity is what has to survive.
    expect(parse('<p><a class="okb-doc-link" data-nid="42" href="/handbook/release">Release process</a></p>'))
      .toMatchObject({ type: 'docLink', attrs: { nid: 42, block: null, label: 'Release process' } })
  })

  it('keeps a block target too', () => {
    expect(parse('<p><a class="okb-doc-link" data-nid="42" data-block="b-4f2a" href="/handbook/release#b-4f2a">Rollback</a></p>'))
      .toMatchObject({ type: 'docLink', attrs: { nid: 42, block: 'b-4f2a' } })
  })

  it('leaves an ordinary link a link', () => {
    expect(parse('<p><a href="/handbook/release">Release process</a></p>'))
      .toMatchObject({ type: 'text', marks: [{ type: 'link' }] })
  })
})
