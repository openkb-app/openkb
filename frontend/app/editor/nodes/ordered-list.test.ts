// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import type { JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { OkbOrderedList } from './ordered-list'
import { parseMarkdownToJson, serializeDocToMarkdown } from '~/comark/markdown-engine'

let editor: Editor

beforeEach(() => {
  editor = new Editor({ extensions: [StarterKit.configure({ orderedList: false }), OkbOrderedList] })
})

afterEach(() => editor.destroy())

/** A paste event carrying `strings` by type. */
function pasteEvent(strings: Record<string, string>): ClipboardEvent {
  const clipboardData = { files: [], getData: (type: string) => strings[type] ?? '' }
  return { clipboardData, preventDefault() {}, stopPropagation() {} } as unknown as ClipboardEvent
}

/** Pastes plain text through the editor's paste handlers. */
function pasteText(text: string) {
  editor.view.pasteText(text, pasteEvent({ 'text/plain': text }))
}

/** Pastes HTML through the editor's paste handlers. */
function pasteHTML(html: string) {
  editor.view.pasteHTML(html, pasteEvent({ 'text/html': html }))
}

/** The non-empty blocks' types. */
const blockTypes = (doc: JSONContent = editor.getJSON()) =>
  (doc.content ?? []).filter(block => block.content?.length).map(block => block.type)

/** The stored body, checking it reloads to the blocks the editor shows. */
async function body(): Promise<string> {
  const markdown = await serializeDocToMarkdown(editor.state.doc)
  expect(blockTypes(await parseMarkdownToJson(markdown))).toEqual(blockTypes())
  // The editor's trailing empty paragraph writes as a blank line.
  return markdown.trimEnd()
}

describe('pasting plain text', () => {
  it('keeps letter markers as text', async () => {
    pasteText('a) foo\nb) bar')
    expect(blockTypes()).toEqual(['paragraph', 'paragraph'])
    expect(await body()).toBe('a) foo\n\nb) bar')
  })

  it('keeps a roman marker as text', async () => {
    pasteText('x) yes')
    expect(blockTypes()).toEqual(['paragraph'])
    expect(await body()).toBe('x) yes')
  })

  it('makes digit markers a list', async () => {
    pasteText('3) three\n4) four')
    expect(editor.getJSON().content?.[0]).toMatchObject({ type: 'orderedList', attrs: { start: 3 } })
    expect(await body()).toBe('3. three\n4. four')
  })
})

describe('pasting HTML', () => {
  it('makes an <ol type="a"> a digit list', async () => {
    pasteHTML('<ol type="a"><li><p>foo</p></li><li><p>bar</p></li></ol>')
    expect(editor.getJSON().content?.[0]).toMatchObject({ type: 'orderedList', attrs: { start: 1 } })
    expect(await body()).toBe('1. foo\n2. bar')
  })

  it('makes a Google Docs lower-roman list a digit list', async () => {
    pasteHTML('<ol><li style="list-style-type:lower-roman"><p>foo</p></li><li style="list-style-type:lower-roman"><p>bar</p></li></ol>')
    expect(editor.getJSON().content?.[0]?.attrs).not.toHaveProperty('type')
    expect(await body()).toBe('1. foo\n2. bar')
  })
})
