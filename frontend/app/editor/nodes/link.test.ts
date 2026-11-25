// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { buildCommitSchemaExtensions } from '~~/server/utils/editor-schema'
import { parseMarkdownToJson, serializeDocToMarkdown } from '~/comark/markdown-engine'

let editor: Editor

/** Opens an editor on `markdown` with the caret at the end of its last paragraph. */
async function openEditorAtEnd(markdown: string): Promise<void> {
  editor = new Editor({
    extensions: buildCommitSchemaExtensions(),
    content: await parseMarkdownToJson(markdown),
  })
  editor.commands.setTextSelection(editor.state.doc.content.size - 1)
}

/** Presses ArrowRight in the editor. */
function pressArrowRight(): void {
  editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
}

/** Types like the view does: the text takes the stored marks, else the caret's. */
function typeAtCaret(text: string): void {
  const { from, to } = editor.state.selection
  editor.view.dispatch(editor.state.tr.insertText(text, from, to))
}

/** The document as comark markdown. */
async function serializedMarkdown(): Promise<string> {
  return (await serializeDocToMarkdown(editor.getJSON())).trim()
}

/** The mark names on the text node that holds `text`. */
function markNamesOnTextHolding(text: string): string[] {
  let names: string[] = []
  editor.state.doc.descendants((node) => {
    if (node.isText && node.text!.includes(text)) names = node.marks.map(mark => mark.type.name).sort()
  })
  return names
}

afterEach(() => editor?.destroy())

describe('ArrowRight at the end of a paragraph', () => {
  it('leaves both marks of a linked inline code', async () => {
    await openEditorAtEnd('See [`code`](https://example.com)')
    pressArrowRight()
    typeAtCaret('more text')
    expect(await serializedMarkdown()).toBe('See [`code`](https://example.com) more text')
  })

  it('leaves a plain inline code', async () => {
    await openEditorAtEnd('See `code`')
    pressArrowRight()
    typeAtCaret('more text')
    expect(await serializedMarkdown()).toBe('See `code` more text')
  })

  it('leaves a plain link', async () => {
    await openEditorAtEnd('See [the guide](https://example.com)')
    pressArrowRight()
    typeAtCaret('more text')
    expect(await serializedMarkdown()).toBe('See [the guide](https://example.com) more text')
  })

  it('keeps a mark that does not exit', async () => {
    await openEditorAtEnd('See **[`code`](https://example.com)**')
    pressArrowRight()
    typeAtCaret('more')
    expect(markNamesOnTextHolding('more')).toEqual(['bold'])
  })
})

describe('typing at the end without ArrowRight', () => {
  it('continues a plain inline code', async () => {
    await openEditorAtEnd('See `code`')
    typeAtCaret('more')
    expect(await serializedMarkdown()).toBe('See `codemore`')
  })
})

describe('typing after a link inside bold', () => {
  it('keeps the space before the typed text', async () => {
    await openEditorAtEnd('See [**the guide**](https://example.com)')
    for (const character of ' more') typeAtCaret(character)
    expect(await serializedMarkdown()).toBe('See [**the guide**](https://example.com) **more**')
  })
})
