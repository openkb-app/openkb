// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { buildCommitSchemaExtensions } from '~~/server/utils/editor-schema'
import { parseMarkdownToJson } from '~/comark/markdown-engine'

const uploadIntoEditor = vi.fn(async () => {})
vi.mock('~/editor/page-file-insert', () => ({ uploadIntoEditor }))

const { PageImageFileHandler, pastedName } = await import('./paste-image')

/** A clipboard holding `files` and the `strings` by type. */
function clipboard(files: File[], strings: Record<string, string> = {}): DataTransfer {
  return {
    files,
    getData: (type: string) => strings[type] ?? '',
  } as unknown as DataTransfer
}

const png = (name = 'image.png') => new File(['png'], name, { type: 'image/png' })

let editor: Editor

beforeEach(() => {
  editor = new Editor({ extensions: [...buildCommitSchemaExtensions(), PageImageFileHandler] })
  editor.commands.setContent(parseMarkdownToJson('First.\n\nSecond.'))
})

afterEach(() => {
  editor.destroy()
  uploadIntoEditor.mockClear()
})

/** Runs the editor's paste handlers on `data`; true when one took it. */
function paste(data: DataTransfer): boolean {
  const event = { clipboardData: data, preventDefault() {}, stopPropagation() {} } as unknown as ClipboardEvent
  return editor.view.someProp('handlePaste', handle => handle(editor.view, event, editor.state.doc.slice(0, 0))) ?? false
}

describe('pastedName', () => {
  it('names the file after the paste time and the image type', () => {
    expect(pastedName('image/png', new Date(2026, 9, 21, 9, 5, 7))).toBe('pasted-20261021-090507.png')
    expect(pastedName('image/jpeg', new Date(2026, 0, 2, 13, 0, 0))).toBe('pasted-20260102-130000.jpg')
  })
})

describe('PageImageFileHandler', () => {
  it('uploads pasted images through the block menu\'s upload, at the caret, naming the nameless ones', () => {
    editor.commands.setTextSelection(4)
    expect(paste(clipboard([png(), png('blob'), png('diagram.png')]))).toBe(true)
    expect(uploadIntoEditor).toHaveBeenCalledWith(editor, 'image', expect.any(Array), 4)
    const files = (uploadIntoEditor.mock.calls[0] as unknown as [unknown, unknown, File[]])[2]
    expect(files.map(file => file.name)).toEqual([expect.stringMatching(/^pasted-\d{8}-\d{6}\.png$/), expect.stringMatching(/^pasted-\d{8}-\d{6}\.png$/), 'diagram.png'])
  })

  it('leaves a paste with HTML content to the editor, taking no file', () => {
    expect(paste(clipboard([png()], { 'text/html': '<p>A snippet <img src="https://example.com/a.png"></p>', 'text/plain': 'A snippet' }))).toBe(false)
    expect(uploadIntoEditor).not.toHaveBeenCalled()
  })

  it('leaves a text-only paste to the editor', () => {
    expect(paste(clipboard([], { 'text/plain': 'Words', 'text/html': '<p>Words</p>' }))).toBe(false)
    expect(uploadIntoEditor).not.toHaveBeenCalled()
  })

  it('leaves files the image field does not take to the editor', () => {
    expect(paste(clipboard([new File(['%PDF'], 'plan.pdf', { type: 'application/pdf' })]))).toBe(false)
    expect(uploadIntoEditor).not.toHaveBeenCalled()
  })
})
