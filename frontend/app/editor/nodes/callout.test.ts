// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { Editor } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Text from '@tiptap/extension-text'
import { Callout } from './callout'
import { Infobox } from './infobox'
import { OkbParagraph } from './markdown-overrides'

function parse(html: string) {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [Document, OkbParagraph, Text, Callout, Infobox],
    content: html,
  })
  const json = editor.getJSON()
  editor.destroy()
  return json.content
}

describe('pasting a callout', () => {
  it('keeps the node when the editor’s own clipboard HTML is pasted', () => {
    expect(parse('<custom-callout type="warning"><p>Mind the gap.</p></custom-callout>'))
      .toMatchObject([{ type: 'callout', attrs: { type: 'warning' } }])
  })

  it('keeps the words but not the callout when the read page is pasted', () => {
    // The read page renders CustomCallout's own root, so nothing on the
    // clipboard says "callout" — the fence has to be re-applied by hand.
    const rendered = '<div class="my-4 rounded-lg ring-1 px-4 py-3 flex gap-3">'
      + '<div class="okb-box-body"><p>Mind the gap.</p></div></div>'
    expect(parse(rendered)).toMatchObject([{ type: 'paragraph' }])
  })
})

describe('pasting an infobox', () => {
  it('keeps the node when the editor’s own clipboard HTML is pasted', () => {
    expect(parse('<custom-infobox title="Note"><p>Body.</p></custom-infobox>'))
      .toMatchObject([{ type: 'infobox', attrs: { title: 'Note' } }])
  })

  it('keeps the words but not the infobox when the read page is pasted', () => {
    const rendered = '<section class="my-5 rounded-xl border px-5 py-4">'
      + '<h3 class="okb-box-title">Note</h3>'
      + '<div class="okb-box-body"><p>Body.</p></div></section>'
    expect(parse(rendered)).toMatchObject([{ type: 'paragraph' }, { type: 'paragraph' }])
  })
})
