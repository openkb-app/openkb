// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { buildCommitSchemaExtensions } from '~~/server/utils/editor-schema'
import { parseMarkdownToJson, serializeDocToMarkdown } from '~/comark/markdown-engine'
import { PageFileLinks } from './page-file-links'

const FILE = '11111111-2222-4333-8444-555555555555'
const files = [{ uuid: FILE, name: 'plan.pdf', size: 10, url: 'http://drupal.test/system/files/attachments/plan%20v2.pdf' }]

let editor: Editor

afterEach(() => editor?.destroy())

function mount(markdown: string): Editor {
  editor = new Editor({
    extensions: [...buildCommitSchemaExtensions(), PageFileLinks.configure({ files: () => files })],
    content: parseMarkdownToJson(markdown),
  })
  return editor
}

const markdown = () => serializeDocToMarkdown(editor.getJSON()).trim()

describe('PageFileLinks', () => {
  it('turns a pasted link to a page file into the file link, keeping its words', () => {
    mount('See here.')
    editor.commands.insertContentAt(5, '<a href="/system/files/attachments/plan v2.pdf">the plan</a> ')
    expect(markdown()).toBe(`See :attachment[the plan]{file="${FILE}"} here.`)
  })

  it('names a bare URL link by the file', () => {
    mount('See here.')
    const url = 'http://node1.test/system/files/attachments/plan%20v2.pdf'
    editor.commands.insertContentAt(5, `<a href="${url}">${url}</a> `)
    expect(markdown()).toBe(`See :attachment{file="${FILE}"} here.`)
  })

  it('leaves other links alone', () => {
    mount('See here.')
    editor.commands.insertContentAt(5, '<a href="/system/files/attachments/other.pdf">other</a> ')
    expect(markdown()).toBe('See [other](/system/files/attachments/other.pdf) here.')
  })
})
