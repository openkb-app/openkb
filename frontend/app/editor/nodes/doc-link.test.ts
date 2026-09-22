// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Text from '@tiptap/extension-text'
import { OkbDocLink, docLinkLabel } from './doc-link'
import { OkbLink, OkbParagraph } from './markdown-overrides'

describe('docLinkLabel', () => {
  it('keeps a bracketed title inside the component', () => {
    // comark reads the label up to the first `]` and offers no escape, so a
    // bracket would truncate the link's words.
    expect(docLinkLabel('Release [beta] process')).toBe('Release (beta) process')
  })

  it('leaves an ordinary title alone', () => {
    expect(docLinkLabel('Release process')).toBe('Release process')
  })
})

describe('pasting a rendered document link', () => {
  function parse(html: string) {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [Document, OkbParagraph, Text, OkbLink.configure({ openOnClick: false }), OkbDocLink],
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
