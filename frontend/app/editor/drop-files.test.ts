// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { Slice } from '@tiptap/pm/model'
import { buildCommitSchemaExtensions } from '~~/server/utils/editor-schema'
import { parseMarkdownToJson } from '~/comark/markdown-engine'

const uploadIntoEditor = vi.fn(async () => {})
const pageFileLimits = vi.fn(async () => ({ extensions: ['png', 'gif', 'jpg', 'jpeg', 'webp'], maxBytes: 1000 }))
vi.mock('~/editor/page-file-insert', () => ({ uploadIntoEditor, pageFileLimits }))

const { PageFileDropHandler, droppedKind } = await import('./drop-files')
const { PageImageFileHandler } = await import('./paste-image')

const file = (name: string, type: string) => new File(['x'], name, { type })

/** The kind `uploadIntoEditor` was given for each file of its last call. */
function uploadedKinds(): string[] {
  const [, kind, files] = uploadIntoEditor.mock.lastCall as unknown as [Editor, (file: File) => string, File[]]
  return files.map(kind)
}

/** Drops `files` at `pos` through the view's drop handlers. */
function drop(files: File[], pos: number): boolean {
  vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos, inside: -1 })
  const event = { dataTransfer: { types: ['Files'], files }, clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {} } as unknown as DragEvent
  return editor.view.someProp('handleDrop', handle => handle(editor.view, event, Slice.empty, false)) ?? false
}

let editor: Editor

beforeEach(() => {
  editor = new Editor({ extensions: [...buildCommitSchemaExtensions(), PageImageFileHandler, PageFileDropHandler] })
})

afterEach(() => {
  editor.destroy()
  uploadIntoEditor.mockClear()
})

describe('droppedKind', () => {
  const images = ['png', 'jpg', 'jpeg']

  it('makes a file with an extension the image field takes a page image, any other file a file card', () => {
    expect(droppedKind(file('shot.png', 'image/png'), images)).toBe('image')
    expect(droppedKind(file('Photo.JPG', 'image/jpeg'), images)).toBe('image')
    expect(droppedKind(file('shot.png', ''), images)).toBe('image')
    expect(droppedKind(file('logo.svg', 'image/svg+xml'), images)).toBe('file')
    expect(droppedKind(file('plan.pdf', 'application/pdf'), images)).toBe('file')
    expect(droppedKind(file('png', ''), images)).toBe('file')
  })
})

describe('PageFileDropHandler', () => {
  it('uploads a dropped PDF and PNG once, at the drop point, kind per file by the image field', async () => {
    editor.commands.setContent(parseMarkdownToJson('First.\n\nSecond.'))
    const files = [file('plan.pdf', 'application/pdf'), file('shot.png', 'image/png'), file('scan.png', '')]
    expect(drop(files, 4)).toBe(true)
    await vi.waitFor(() => expect(uploadIntoEditor).toHaveBeenCalledOnce())
    expect(uploadIntoEditor).toHaveBeenCalledWith(editor, expect.any(Function), files, 4)
    expect(uploadedKinds()).toEqual(['file', 'image', 'image'])
  })

  it('drops into a list after the list', async () => {
    editor.commands.setContent(parseMarkdownToJson('- One\n- Two\n\nAfter.'))
    drop([file('plan.pdf', 'application/pdf')], 4)
    await vi.waitFor(() => expect(uploadIntoEditor).toHaveBeenCalledOnce())
    expect(uploadIntoEditor).toHaveBeenCalledWith(editor, expect.any(Function), expect.any(Array), editor.state.doc.firstChild!.nodeSize)
  })

  it('follows the drop point through edits made while the image field limits load', async () => {
    editor.commands.setContent(parseMarkdownToJson('First.\n\nSecond.'))
    let resolve!: (limits: { extensions: string[], maxBytes: number }) => void
    pageFileLimits.mockReturnValueOnce(new Promise(r => (resolve = r)))
    drop([file('plan.pdf', 'application/pdf')], 9)
    editor.commands.insertContentAt(1, 'Typed ')
    resolve({ extensions: ['png'], maxBytes: 1000 })
    await vi.waitFor(() => expect(uploadIntoEditor).toHaveBeenCalledOnce())
    expect(uploadIntoEditor).toHaveBeenCalledWith(editor, expect.any(Function), expect.any(Array), 9 + 'Typed '.length)
  })

  it('makes every file a file card without the image field limits', async () => {
    pageFileLimits.mockResolvedValueOnce(undefined as never)
    drop([file('shot.png', 'image/png')], 1)
    await vi.waitFor(() => expect(uploadIntoEditor).toHaveBeenCalledOnce())
    expect(uploadedKinds()).toEqual(['file'])
  })
})
