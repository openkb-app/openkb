// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { Editor } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import * as Y from 'yjs'
import { buildCommitSchemaExtensions } from '~~/server/utils/editor-schema'
import { parseMarkdownToJson } from '~/comark/markdown-engine'
import { addPageFile, fileArray } from '#shared/utils/page-files'
import { CollabHistory } from './collab-history'
import { redo, undo } from '@tiptap/y-tiptap'
import { closeFilePicker, insertPageFile, pickPageAttachment, removeFileEmbeds, removeFileFromPage, replacePageFile, uploadIntoEditor, useFilePickerRequest } from './page-file-insert'

const FILE = '66666666-7777-4888-9999-000000000000'

const shot = () => new File(['png'], 'shot.png', { type: 'image/png' })

/** XHRs sent so far, with their headers; `answer()` finishes one with FILE, `refuse()` with a 422. */
const sent: Array<{ headers: Record<string, string>, answer: () => void, refuse: () => void }> = []

/** Toasts shown, by id; removed ones are dropped. */
const toasts = new Map<string, { title?: string, description?: string, color?: string }>()

class FakeXhr {
  status = 0
  responseText = ''
  upload = new EventTarget()
  private events = new EventTarget()
  private headers: Record<string, string> = {}
  open() {}
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value
  }

  addEventListener(type: string, listener: () => void) {
    this.events.addEventListener(type, listener)
  }

  send() {
    sent.push({
      headers: this.headers,
      answer: () => {
        this.status = 201
        this.responseText = JSON.stringify({ id: FILE })
        this.events.dispatchEvent(new Event('load'))
      },
      refuse: () => {
        this.status = 422
        this.responseText = JSON.stringify({ statusMessage: 'Only pdf files are allowed.' })
        this.events.dispatchEvent(new Event('load'))
      },
    })
  }
}

let editor: Editor
let peer: Editor

/** Two editors sharing `markdown` over Yjs: ours and the peer's. */
function mountShared(markdown: string): void {
  const ours = new Y.Doc()
  const theirs = new Y.Doc()
  ours.on('update', (update: Uint8Array, origin: unknown) => origin !== theirs && Y.applyUpdate(theirs, update, ours))
  theirs.on('update', (update: Uint8Array, origin: unknown) => origin !== ours && Y.applyUpdate(ours, update, theirs))
  const extensions = (document: Y.Doc) => [...buildCommitSchemaExtensions(), Collaboration.configure({ document }), CollabHistory]
  peer = new Editor({ extensions: extensions(theirs) })
  peer.commands.setContent(parseMarkdownToJson(markdown))
  editor = new Editor({ extensions: extensions(ours) })
}

/** Block types and texts of our document, in order. */
const blocks = () => editor.state.doc.content.content.map(node => ['image', 'attachment'].includes(node.type.name) ? `${node.type.name}:${node.attrs.file}` : node.textContent)
const sessionYDoc = () => editor.extensionManager.extensions.find(extension => extension.name === 'collaboration')!.options.document as Y.Doc

beforeEach(() => {
  sent.length = 0
  const states = new Map<string, ReturnType<typeof ref>>()
  vi.stubGlobal('useState', (key: string, init: () => unknown) => states.get(key) ?? states.set(key, ref(init())).get(key))
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
  vi.stubGlobal('$fetch', async () => 'csrf-1')
  toasts.clear()
  let toastId = 0
  vi.stubGlobal('useToast', () => ({
    add: (toast: { id?: string }) => toasts.set(toast.id ?? `t${++toastId}`, toast),
    update: (id: string, patch: object) => toasts.set(id, { ...toasts.get(id), ...patch }),
    remove: (id: string) => toasts.delete(id),
  }))
})

afterEach(() => {
  peer?.destroy()
  editor?.destroy()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('uploadIntoEditor', () => {
  it('sends the session\'s CSRF token with the upload', async () => {
    mountShared('First.')
    const done = uploadIntoEditor(editor, 'images', [shot()], editor.state.doc.content.size)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]!.headers['X-CSRF-Token']).toBe('csrf-1')
    sent[0]!.answer()
    await done
  })

  it('inserts the image where it was asked for when the peer types before it and elsewhere', async () => {
    mountShared('First.\n\nSecond.')
    const done = uploadIntoEditor(editor, 'images', [shot()], editor.state.doc.child(0).nodeSize)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    peer.commands.insertContentAt(1, 'Peer: ')
    peer.commands.insertContentAt(peer.state.doc.content.size - 1, ' More.')
    sent[0]!.answer()
    await done
    expect(blocks()).toEqual(['Peer: First.', `image:${FILE}`, 'Second. More.'])
  })
})

describe('upload toasts', () => {
  it('shows progress while uploading and drops it once the file landed', async () => {
    mountShared('First.')
    const done = uploadIntoEditor(editor, 'images', [shot()], editor.state.doc.content.size)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect([...toasts.values()]).toEqual([expect.objectContaining({ title: 'Uploading shot.png', description: '0%' })])
    sent[0]!.answer()
    await done
    expect(toasts.size).toBe(0)
  })

  it('refuses a file over the limit Drupal publishes before sending it', async () => {
    vi.stubGlobal('$fetch', async (url: string) => url === '/api/openkb/schema'
      ? { files: { field_kb_images: { extensions: ['png'], maxBytes: 2 } } }
      : 'csrf-1')
    mountShared('First.')
    await uploadIntoEditor(editor, 'images', [shot()], editor.state.doc.content.size)
    expect(sent).toHaveLength(0)
    expect([...toasts.values()]).toEqual([expect.objectContaining({ title: 'shot.png was not uploaded', description: 'It is too large: the limit is 2 B.' })])
  })

  it('replaces the progress toast with an error toast on a refusal', async () => {
    mountShared('First.')
    const done = uploadIntoEditor(editor, 'images', [shot()], editor.state.doc.content.size)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    sent[0]!.refuse()
    await done
    expect([...toasts.values()]).toEqual([{ title: 'shot.png was not uploaded', description: 'Only pdf files are allowed.', color: 'error', icon: 'i-lucide-circle-alert', duration: 0 }])
    expect(blocks()).toEqual(['First.'])
  })
})

describe('insertPageFile', () => {
  it('inserts the picked file where it was asked for when the peer types before it and elsewhere', async () => {
    mountShared('First.\n\nSecond.')
    const done = insertPageFile(editor, true, editor.state.doc.child(0).nodeSize)
    const token = useFilePickerRequest().value!.token
    peer.commands.insertContentAt(1, 'Peer: ')
    peer.commands.insertContentAt(peer.state.doc.content.size - 1, ' More.')
    closeFilePicker(token, { id: FILE, mime: 'image/png' })
    await done
    expect(blocks()).toEqual(['Peer: First.', `image:${FILE}`, 'Second. More.'])
  })

  it('uploads into the place it was asked for on the upload choice', async () => {
    mountShared('First.\n\nSecond.')
    const done = insertPageFile(editor, true, editor.state.doc.child(0).nodeSize)
    peer.commands.insertContentAt(1, 'Peer: ')
    closeFilePicker(useFilePickerRequest().value!.token, { upload: [shot()] })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    sent[0]!.answer()
    await done
    expect(blocks()).toEqual(['Peer: First.', `image:${FILE}`, 'Second.'])
  })

  it('puts an image picked as a file on the page as a file card', async () => {
    mountShared('First.\n\nSecond.')
    const done = insertPageFile(editor, false, editor.state.doc.child(0).nodeSize)
    closeFilePicker(useFilePickerRequest().value!.token, { id: FILE, mime: 'image/png' })
    await done
    expect(blocks()).toEqual(['First.', `attachment:${FILE}`, 'Second.'])
    expect(fileArray(sessionYDoc(), 'attachments').toArray()).toEqual([FILE])
    expect(fileArray(sessionYDoc(), 'images').toArray()).toEqual([])
  })

  it('leaves the page as it was on dismiss', async () => {
    mountShared('First.')
    const done = insertPageFile(editor, false, editor.state.doc.content.size)
    closeFilePicker(useFilePickerRequest().value!.token, null)
    await done
    expect(blocks()).toEqual(['First.'])
  })
})

describe('pickPageAttachment', () => {
  it('opens the file picker for one file and lists the chosen file once linked', async () => {
    mountShared('First.')
    const link = vi.fn(() => true)
    const picked = pickPageAttachment(editor, link)
    expect(useFilePickerRequest().value).toMatchObject({ images: false, multiple: false })
    closeFilePicker(useFilePickerRequest().value!.token, { id: FILE, mime: 'image/png' })
    await picked
    expect(link).toHaveBeenCalledWith(FILE)
    expect(fileArray(sessionYDoc(), 'attachments').toArray()).toEqual([FILE])
  })

  it('leaves a chosen file off the list when the link fails', async () => {
    mountShared('First.')
    const picked = pickPageAttachment(editor, () => false)
    closeFilePicker(useFilePickerRequest().value!.token, { id: FILE, mime: 'image/png' })
    await picked
    expect(fileArray(sessionYDoc(), 'attachments').toArray()).toEqual([])
  })

  it('uploads the file the picker gives', async () => {
    mountShared('First.')
    const link = vi.fn(() => true)
    const picked = pickPageAttachment(editor, link)
    closeFilePicker(useFilePickerRequest().value!.token, { upload: [shot()] })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    sent[0]!.answer()
    await picked
    expect(link).toHaveBeenCalledWith(FILE)
    expect(fileArray(sessionYDoc(), 'attachments').toArray()).toEqual([FILE])
  })

  it('links nothing on dismiss', async () => {
    mountShared('First.')
    const link = vi.fn(() => true)
    const picked = pickPageAttachment(editor, link)
    closeFilePicker(useFilePickerRequest().value!.token, null)
    await picked
    expect(link).not.toHaveBeenCalled()
  })
})

describe('removeFileEmbeds', () => {
  const OTHER = '11111111-2222-4333-8444-555555555555'

  it('takes the file\'s cards out and leaves its inline link\'s words', () => {
    mountShared(`Intro.\n\n::attachment{file="${FILE}"}\n::\n\nSee :attachment[the plan]{file="${FILE}"} now.\n\n::attachment{file="${OTHER}"}\n::\n\nEnd.`)
    removeFileEmbeds(editor, ['attachments'], FILE)
    expect(editor.state.doc.content.content.map(node => node.type.name === 'attachment' ? `attachment:${node.attrs.file}` : node.textContent))
      .toEqual(['Intro.', 'See the plan now.', `attachment:${OTHER}`, 'End.'])
  })

  it('takes an image out only for the images list', () => {
    mountShared(`::image{file="${FILE}" alt="Plan"}\n::\n\nText.`)
    removeFileEmbeds(editor, ['attachments'], FILE)
    expect(blocks()).toEqual([`image:${FILE}`, 'Text.'])
    removeFileEmbeds(editor, ['images'], FILE)
    expect(blocks()).toEqual(['Text.'])
  })

  it('keeps the file\'s name as the words of a label-less inline link', () => {
    mountShared(`See :attachment{file="${FILE}"} now.`)
    removeFileEmbeds(editor, ['attachments'], FILE, 'plan.pdf')
    expect(blocks()).toEqual(['See plan.pdf now.'])
  })
})

describe('removeFileFromPage', () => {
  // The session's undo is the Y.js UndoManager's (the schema's StarterKit keeps ProseMirror's own).
  it('is one undo step: undo brings back the embed and the list entry', () => {
    mountShared(`::image{file="${FILE}" alt="Plan"}\n::\n\nText.`)
    const doc = editor.extensionManager.extensions.find(extension => extension.name === 'collaboration')!.options.document as Y.Doc
    addPageFile(doc, 'images', FILE)
    removeFileFromPage(editor, ['images'], FILE)
    expect(blocks()).toEqual(['Text.'])
    expect(fileArray(doc, 'images').toArray()).toEqual([])
    undo(editor.state)
    expect(blocks()).toEqual([`image:${FILE}`, 'Text.'])
    expect(fileArray(doc, 'images').toArray()).toEqual([FILE])
    redo(editor.state)
    expect(blocks()).toEqual(['Text.'])
    expect(fileArray(doc, 'images').toArray()).toEqual([])
  })
  it('is one undo step for a file in both lists', () => {
    mountShared(`::image{file="${FILE}" alt="Plan"}\n::\n\n::attachment{file="${FILE}"}\n::\n\nText.`)
    const doc = editor.extensionManager.extensions.find(extension => extension.name === 'collaboration')!.options.document as Y.Doc
    addPageFile(doc, 'images', FILE)
    addPageFile(doc, 'attachments', FILE)
    removeFileFromPage(editor, ['images', 'attachments'], FILE)
    expect(blocks()).toEqual(['Text.'])
    expect([fileArray(doc, 'images').length, fileArray(doc, 'attachments').length]).toEqual([0, 0])
    undo(editor.state)
    expect(blocks()).toEqual([`image:${FILE}`, `attachment:${FILE}`, 'Text.'])
    expect(fileArray(doc, 'images').toArray()).toEqual([FILE])
    expect(fileArray(doc, 'attachments').toArray()).toEqual([FILE])
  })
})

describe('replacePageFile', () => {
  const OLD = '11111111-2222-4333-8444-555555555555'
  const sessionDoc = () => (editor.extensionManager.extensions.find(e => e.name === 'collaboration')!.options as { document: Y.Doc }).document

  it('swaps the image\'s file, keeps its alt text and drops the old file from the list', async () => {
    mountShared(`Peer text.\n\n::image{file="${OLD}" alt="Plan"}\n::`)
    fileArray(sessionDoc(), 'images').push([OLD])
    const pos = editor.state.doc.child(0).nodeSize
    const done = replacePageFile(editor, pos)
    peer.commands.insertContentAt(1, 'More ')
    closeFilePicker(useFilePickerRequest().value!.token, { id: FILE, mime: 'image/png' })
    await done
    const image = editor.state.doc.content.content.find(node => node.type.name === 'image')!
    expect(image.attrs).toMatchObject({ file: FILE, alt: 'Plan' })
    expect(fileArray(sessionDoc(), 'images').toArray()).toEqual([FILE])
  })

  it('keeps the old file listed while another embed still shows it', async () => {
    mountShared(`::image{file="${OLD}" alt="A"}\n::\n\n::image{file="${OLD}" alt="B"}\n::`)
    fileArray(sessionDoc(), 'images').push([OLD])
    const done = replacePageFile(editor, 0)
    closeFilePicker(useFilePickerRequest().value!.token, { id: FILE, mime: 'image/png' })
    await done
    expect(blocks().filter(Boolean)).toEqual([`image:${FILE}`, `image:${OLD}`])
    expect(fileArray(sessionDoc(), 'images').toArray()).toEqual([OLD, FILE])
  })

  it('is one undo step: undo brings back the old file, in the image and in the list', async () => {
    mountShared(`::image{file="${OLD}" alt="Plan"}\n::`)
    fileArray(sessionDoc(), 'images').push([OLD])
    const done = replacePageFile(editor, 0)
    closeFilePicker(useFilePickerRequest().value!.token, { id: FILE, mime: 'image/png' })
    await done
    undo(editor.state)
    expect(blocks().filter(Boolean)).toEqual([`image:${OLD}`])
    expect(fileArray(sessionDoc(), 'images').toArray()).toEqual([OLD])
    redo(editor.state)
    expect(blocks().filter(Boolean)).toEqual([`image:${FILE}`])
    expect(fileArray(sessionDoc(), 'images').toArray()).toEqual([FILE])
  })
})
