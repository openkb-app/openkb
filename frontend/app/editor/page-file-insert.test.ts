// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { Editor } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import * as Y from 'yjs'
import { TextSelection } from '@tiptap/pm/state'
import { buildCommitSchemaExtensions } from '~~/server/utils/editor-schema'
import { parseMarkdownToJson } from '~/comark/markdown-engine'
import type { PageFileKey } from '#shared/utils/files'
import { addPageFile, fileArray, liveHiddenFiles, setFileHidden } from '#shared/utils/page-files'
import { BlockIdMinter } from './block-id-minter'
import { CollabHistory } from './collab-history'
import { redo, undo, yUndoPluginKey } from '@tiptap/y-tiptap'
import { closeFilePicker, type FilePickerChoice, insertPageFile, pickPageAttachment, removeFileEmbeds, removeFileFromPage, replacePageFile, undoableFileChange, uploadIntoEditor, useFilePickerRequest } from './page-file-insert'

const FILE = '66666666-7777-4888-9999-000000000000'

const shot = () => new File(['png'], 'shot.png', { type: 'image/png' })

/** XHRs sent so far, with their headers; `answer()` finishes one with FILE, `refuse()` with a 422. */
const sent: Array<{ headers: Record<string, string>, answer: (id?: string) => void, refuse: () => void }> = []

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
      answer: (id = FILE) => {
        this.status = 201
        this.responseText = JSON.stringify({ id })
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
  const extensions = (document: Y.Doc) => [...buildCommitSchemaExtensions(), Collaboration.configure({ document }), CollabHistory, BlockIdMinter]
  peer = new Editor({ extensions: extensions(theirs) })
  peer.commands.setContent(parseMarkdownToJson(markdown))
  editor = new Editor({ extensions: extensions(ours) })
}

/** Block types and texts of our document, in order. */
const blocks = () => editor.state.doc.content.content.map(node => ['image', 'attachment', 'embed'].includes(node.type.name) ? `${node.type.name}:${node.attrs.file}` : node.textContent)
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
    const done = uploadIntoEditor(editor, 'image', [shot()], editor.state.doc.content.size)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]!.headers['X-CSRF-Token']).toBe('csrf-1')
    sent[0]!.answer()
    await done
  })

  it('inserts the image where it was asked for when the peer types before it and elsewhere', async () => {
    mountShared('First.\n\nSecond.')
    const done = uploadIntoEditor(editor, 'image', [shot()], editor.state.doc.child(0).nodeSize)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    peer.commands.insertContentAt(1, 'Peer: ')
    peer.commands.insertContentAt(peer.state.doc.content.size - 1, ' More.')
    sent[0]!.answer()
    await done
    expect(blocks()).toEqual(['Peer: First.', `image:${FILE}`, 'Second. More.'])
  })

  it('puts the caret after the image only if the user did not move on, so typing on keeps it', async () => {
    mountShared('First.\n\nSecond.')
    const at = editor.state.doc.child(0).nodeSize
    let done = uploadIntoEditor(editor, 'image', [shot()], at)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    sent[0]!.answer()
    await done
    expect(editor.state.selection).toBeInstanceOf(TextSelection)
    expect(editor.state.selection.from).toBe(at + editor.state.doc.child(1).nodeSize + 1)

    done = uploadIntoEditor(editor, 'image', [shot()], at)
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    editor.commands.setTextSelection(3)
    peer.commands.insertContentAt(peer.state.doc.content.size - 1, ' More.')
    sent[1]!.answer()
    await done
    editor.commands.insertContent('x')
    expect(blocks()).toEqual(['Fixrst.', `image:${FILE}`, `image:${FILE}`, 'Second. More.'])
  })

  it('counts the user\'s own undo as moving on, so the next key keeps the image', async () => {
    mountShared('First.\n\nSecond.')
    const at = editor.state.doc.child(0).nodeSize
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' Typed.')
    const done = uploadIntoEditor(editor, 'image', [shot()], at)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    undo(editor.state)
    sent[0]!.answer()
    await done
    editor.commands.insertContent('x')
    expect(blocks()).toContain(`image:${FILE}`)
  })

  it('inserts several files in the order given, whichever upload lands first', async () => {
    const second = '66666666-7777-4888-9999-000000000002'
    mountShared('First.\n\nSecond.')
    const done = uploadIntoEditor(editor, 'image', [shot(), shot()], editor.state.doc.child(0).nodeSize)
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    sent[1]!.answer(second)
    sent[0]!.answer()
    await done
    expect(blocks()).toEqual(['First.', `image:${FILE}`, `image:${second}`, 'Second.'])
  })

  it('puts the caret after the last embed of a multi-file upload', async () => {
    const second = '66666666-7777-4888-9999-000000000002'
    mountShared('First.\n\nSecond.')
    const done = uploadIntoEditor(editor, 'image', [shot(), shot()], editor.state.doc.child(0).nodeSize)
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    sent[0]!.answer()
    sent[1]!.answer(second)
    await done
    editor.commands.insertContent('After ')
    expect(blocks()).toEqual(['First.', `image:${FILE}`, `image:${second}`, 'After Second.'])
  })

  it('adds a paragraph for the caret after an embed at the end of the page', async () => {
    mountShared('First.')
    const done = uploadIntoEditor(editor, 'file', [shot()], editor.state.doc.content.size)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    sent[0]!.answer()
    await done
    editor.commands.insertContent('after')
    expect(blocks()).toEqual(['First.', `attachment:${FILE}`, 'after'])
  })

  it('puts the caret after an embed that split a paragraph, at the start of its rest', async () => {
    mountShared('First.\n\nSecond.')
    const done = uploadIntoEditor(editor, 'image', [shot()], 3)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    sent[0]!.answer()
    await done
    editor.commands.insertContent('x')
    expect(blocks()).toEqual(['Fi', `image:${FILE}`, 'xrst.', 'Second.'])
  })

  for (const [next, text] of [['## Head', 'Head'], ['```\ncode\n```', 'code']] as const) {
    it(`adds a paragraph for the caret before "${text}", so typing on stays out of it`, async () => {
      mountShared(`First.\n\n${next}\n\nLast.`)
      await settle(uploadIntoEditor(editor, 'image', [shot()], editor.state.doc.child(0).nodeSize))
      editor.commands.insertContent('x')
      expect(blocks()).toEqual(['First.', `image:${FILE}`, 'x', text, 'Last.'])
      expect(editor.state.doc.child(2).type.name).toBe('paragraph')
    })
  }

  it('adds a paragraph for the caret after an embed that split a heading', async () => {
    mountShared('First.\n\n## Head\n\nLast.')
    await settle(uploadIntoEditor(editor, 'image', [shot()], editor.state.doc.child(0).nodeSize + 3))
    editor.commands.insertContent('x')
    expect(blocks()).toEqual(['First.', 'He', `image:${FILE}`, 'x', 'ad', 'Last.'])
    expect(editor.state.doc.content.content.map(node => node.type.name)).toEqual(['paragraph', 'heading', 'image', 'paragraph', 'heading', 'paragraph'])
  })

  it('keeps the order given when inserting inside a paragraph', async () => {
    const second = '66666666-7777-4888-9999-000000000002'
    mountShared('First.\n\nSecond.')
    const done = uploadIntoEditor(editor, 'file', [shot(), shot()], editor.state.doc.child(0).nodeSize - 1)
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    sent[0]!.answer()
    sent[1]!.answer(second)
    await done
    expect(blocks()).toEqual(['First.', `attachment:${FILE}`, `attachment:${second}`, 'Second.'])
  })

  it('picks the kind per file, each into its own list, in the order given', async () => {
    const pdf = '66666666-7777-4888-9999-000000000003'
    mountShared('First.\n\nSecond.')
    const files = [shot(), new File(['%PDF'], 'plan.pdf', { type: 'application/pdf' })]
    const done = uploadIntoEditor(editor, file => file.type === 'image/png' ? 'image' : 'file', files, editor.state.doc.child(0).nodeSize)
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    sent[1]!.answer(pdf)
    sent[0]!.answer()
    await done
    expect(blocks()).toEqual(['First.', `image:${FILE}`, `attachment:${pdf}`, 'Second.'])
    expect(fileArray(sessionYDoc(), 'images').toArray()).toEqual([FILE])
    expect(fileArray(sessionYDoc(), 'attachments').toArray()).toEqual([pdf])
  })
})

describe('upload toasts', () => {
  it('shows progress while uploading and drops it once the file landed', async () => {
    mountShared('First.')
    const done = uploadIntoEditor(editor, 'image', [shot()], editor.state.doc.content.size)
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
    await uploadIntoEditor(editor, 'image', [shot()], editor.state.doc.content.size)
    expect(sent).toHaveLength(0)
    expect([...toasts.values()]).toEqual([expect.objectContaining({ title: 'shot.png was not uploaded', description: 'It is too large: the limit is 2 B.' })])
  })

  it('replaces the progress toast with an error toast on a refusal', async () => {
    mountShared('First.')
    const done = uploadIntoEditor(editor, 'image', [shot()], editor.state.doc.content.size)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    sent[0]!.refuse()
    await done
    expect([...toasts.values()]).toEqual([{ title: 'shot.png was not uploaded', description: 'Only pdf files are allowed.', color: 'error', icon: 'i-lucide-circle-alert', duration: 0 }])
    expect(blocks()).toEqual(['First.'])
  })
})

/** Answers the open picker with `choice`, then lets an upload land. */
async function settle(done: Promise<void>, choice?: FilePickerChoice): Promise<void> {
  if (choice) closeFilePicker(useFilePickerRequest().value!.token, choice)
  if (!choice || 'upload' in choice) {
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    sent[0]!.answer()
  }
  await done
}

describe('undoing an insert', () => {
  const OLD = '11111111-2222-4333-8444-555555555555'
  const pdf = () => new File(['%PDF'], 'plan.pdf', { type: 'application/pdf' })
  /** Between the first and the last paragraph: redo of an insert at the page end is OKB-555. */
  const mid = () => editor.state.doc.child(0).nodeSize

  const INSERTS: Array<{ path: string, block: string, key: PageFileKey, insert: () => Promise<void>, page?: string, hidden?: boolean }> = [
    { path: 'paste', block: 'image', key: 'images', insert: () => settle(uploadIntoEditor(editor, 'image', [shot()], mid())) },
    { path: 'drop', block: 'attachment', key: 'attachments', insert: () => settle(uploadIntoEditor(editor, () => 'file', [pdf()], mid())) },
    { path: 'block menu Image', block: 'image', key: 'images', insert: () => settle(insertPageFile(editor, 'image', mid()), { upload: [shot()] }) },
    { path: 'block menu File', block: 'attachment', key: 'attachments', insert: () => settle(insertPageFile(editor, 'file', mid()), { upload: [pdf()] }) },
    { path: 'embed', block: 'embed', key: 'attachments', hidden: true, insert: () => settle(insertPageFile(editor, 'html', mid()), { upload: [new File(['<p>'], 'a.html', { type: 'text/html' })] }) },
    { path: '"My files"', block: 'attachment', key: 'attachments', insert: () => settle(insertPageFile(editor, 'file', mid()), { id: FILE, mime: 'application/pdf' }) },
    {
      path: 'Replace with an upload',
      block: 'image',
      key: 'images',
      page: `First.\n\n::image{file="${OLD}" alt="Plan"}\n::\n\nSecond.`,
      insert: () => {
        editor.commands.setNodeSelection(mid())
        return settle(replacePageFile(editor, mid()), { upload: [shot()] })
      },
    },
  ]

  for (const { path, block, key, insert, page, hidden } of INSERTS) {
    it(`${path}: one undo step with its list entry, redo brings both back, the caret goes after it`, async () => {
      mountShared(page ?? 'First.\n\nSecond.')
      const listed = page ? [OLD] : []
      fileArray(sessionYDoc(), key).push(listed)
      const before = blocks()
      await insert()
      const inserted = ['First.', `${block}:${FILE}`, 'Second.']
      expect(blocks()).toEqual(inserted)
      expect(fileArray(sessionYDoc(), key).toArray()).toEqual([FILE])
      expect(liveHiddenFiles(sessionYDoc())).toEqual(hidden ? [FILE] : [])
      const { selection } = editor.state
      expect(selection).toBeInstanceOf(TextSelection)
      expect([selection.$from.parent.textContent, selection.$from.parentOffset]).toEqual(['Second.', 0])

      undo(editor.state)
      expect(blocks()).toEqual(before)
      expect(fileArray(sessionYDoc(), key).toArray()).toEqual(listed)
      expect(liveHiddenFiles(sessionYDoc())).toEqual([])
      redo(editor.state)
      expect(blocks()).toEqual(inserted)
      expect(fileArray(sessionYDoc(), key).toArray()).toEqual([FILE])
      expect(liveHiddenFiles(sessionYDoc())).toEqual(hidden ? [FILE] : [])
    })
  }

  it('keeps a file listed before the insert listed after its undo', async () => {
    mountShared('First.\n\nSecond.')
    addPageFile(sessionYDoc(), 'attachments', FILE)
    await settle(insertPageFile(editor, 'file', mid()), { id: FILE, mime: 'application/pdf' })
    undo(editor.state)
    expect(blocks()).toEqual(['First.', 'Second.'])
    expect(fileArray(sessionYDoc(), 'attachments').toArray()).toEqual([FILE])
  })

  it('takes an uploaded inline link\'s list entry back with the link', async () => {
    mountShared('First.')
    const picked = pickPageAttachment(editor, (uuid) => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, { type: 'attachmentInline', attrs: { file: uuid } })
      return true
    })
    await settle(picked, { upload: [shot()] })
    expect(fileArray(sessionYDoc(), 'attachments').toArray()).toEqual([FILE])
    undo(editor.state)
    expect(fileArray(sessionYDoc(), 'attachments').toArray()).toEqual([])
    expect(editor.getHTML()).not.toContain(FILE)
  })
})

describe('insertPageFile', () => {
  it('inserts the picked file where it was asked for when the peer types before it and elsewhere', async () => {
    mountShared('First.\n\nSecond.')
    const done = insertPageFile(editor, 'image', editor.state.doc.child(0).nodeSize)
    const token = useFilePickerRequest().value!.token
    peer.commands.insertContentAt(1, 'Peer: ')
    peer.commands.insertContentAt(peer.state.doc.content.size - 1, ' More.')
    closeFilePicker(token, { id: FILE, mime: 'image/png' })
    await done
    expect(blocks()).toEqual(['Peer: First.', `image:${FILE}`, 'Second. More.'])
  })

  it('uploads into the place it was asked for on the upload choice', async () => {
    mountShared('First.\n\nSecond.')
    const done = insertPageFile(editor, 'image', editor.state.doc.child(0).nodeSize)
    peer.commands.insertContentAt(1, 'Peer: ')
    closeFilePicker(useFilePickerRequest().value!.token, { upload: [shot()] })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    sent[0]!.answer()
    await done
    expect(blocks()).toEqual(['Peer: First.', `image:${FILE}`, 'Second.'])
  })

  it('puts an image picked as a file on the page as a file card', async () => {
    mountShared('First.\n\nSecond.')
    const done = insertPageFile(editor, 'file', editor.state.doc.child(0).nodeSize)
    closeFilePicker(useFilePickerRequest().value!.token, { id: FILE, mime: 'image/png' })
    await done
    expect(blocks()).toEqual(['First.', `attachment:${FILE}`, 'Second.'])
    expect(fileArray(sessionYDoc(), 'attachments').toArray()).toEqual([FILE])
    expect(fileArray(sessionYDoc(), 'images').toArray()).toEqual([])
  })

  it('hides a file inserted as an embed from the attachments list, and undo shows it again', async () => {
    mountShared('First.')
    const done = insertPageFile(editor, 'html', editor.state.doc.content.size)
    closeFilePicker(useFilePickerRequest().value!.token, { id: FILE, mime: 'text/html' })
    await done
    const embeds = () => editor.state.doc.content.content.filter(node => node.type.name === 'embed').length
    expect(embeds()).toBe(1)
    expect(liveHiddenFiles(sessionYDoc())).toEqual([FILE])
    undo(editor.state)
    expect(embeds()).toBe(0)
    expect(liveHiddenFiles(sessionYDoc())).toEqual([])
  })

  it('leaves a file inserted as a card listed', async () => {
    mountShared('First.')
    const done = insertPageFile(editor, 'file', editor.state.doc.content.size)
    closeFilePicker(useFilePickerRequest().value!.token, { id: FILE, mime: 'text/html' })
    await done
    expect(liveHiddenFiles(sessionYDoc())).toEqual([])
  })

  it('puts the caret after a picked file and after an embed, so typing on keeps them', async () => {
    mountShared('First.')
    let done = insertPageFile(editor, 'file', editor.state.doc.content.size)
    closeFilePicker(useFilePickerRequest().value!.token, { id: FILE, mime: 'application/pdf' })
    await done
    done = insertPageFile(editor, 'html', editor.state.doc.child(0).nodeSize)
    closeFilePicker(useFilePickerRequest().value!.token, { id: FILE, mime: 'text/html' })
    await done
    editor.commands.insertContent('after')
    expect(editor.state.doc.content.content.map(node => node.type.name)).toEqual(['paragraph', 'embed', 'paragraph', 'attachment', 'paragraph'])
    expect(editor.state.doc.child(2).textContent).toBe('after')
  })

  it('leaves the page as it was on dismiss', async () => {
    mountShared('First.')
    const done = insertPageFile(editor, 'file', editor.state.doc.content.size)
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
    expect(useFilePickerRequest().value).toMatchObject({ kind: 'file', multiple: false })
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

  it('drops the hidden flag with the file, and undo brings it back; the file attached anew is listed', async () => {
    mountShared(`::embed{file="${FILE}"}\n::\n\nText.`)
    const doc = sessionYDoc()
    addPageFile(doc, 'attachments', FILE)
    setFileHidden(doc, FILE, true)
    removeFileFromPage(editor, ['attachments'], FILE)
    expect(liveHiddenFiles(doc)).toEqual([])
    undo(editor.state)
    expect(liveHiddenFiles(doc)).toEqual([FILE])
    redo(editor.state)

    const done = insertPageFile(editor, 'file', editor.state.doc.content.size)
    closeFilePicker(useFilePickerRequest().value!.token, { id: FILE, mime: 'text/html' })
    await done
    expect(fileArray(doc, 'attachments').toArray()).toEqual([FILE])
    expect(liveHiddenFiles(doc)).toEqual([])
  })
})

describe('undoableFileChange', () => {
  it('makes a flag-only change one undo step and tells the editor at once', () => {
    mountShared('Text.')
    addPageFile(sessionYDoc(), 'attachments', FILE)
    let transactions = 0
    editor.on('transaction', () => transactions++)
    undoableFileChange(editor, doc => setFileHidden(doc, FILE, true))
    expect(transactions).toBe(1)
    // The editor's own history is the Y.js UndoManager's (this schema's StarterKit keeps ProseMirror's).
    expect((yUndoPluginKey.getState(editor.state) as { undoManager: Y.UndoManager }).undoManager.undoStack).toHaveLength(1)
    undo(editor.state)
    expect(liveHiddenFiles(sessionYDoc())).toEqual([])
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

  it('puts the caret after the selected block it swapped the file of', async () => {
    mountShared(`::image{file="${OLD}" alt="Plan"}\n::\n\nNext.`)
    editor.commands.setNodeSelection(0)
    const done = replacePageFile(editor, 0)
    closeFilePicker(useFilePickerRequest().value!.token, { id: FILE, mime: 'image/png' })
    await done
    editor.commands.insertContent('x')
    expect(blocks()).toEqual([`image:${FILE}`, 'xNext.'])
  })

  it('leaves a caret the user moved elsewhere where it is', async () => {
    mountShared(`::image{file="${OLD}" alt="Plan"}\n::\n\nNext.`)
    const done = replacePageFile(editor, 0)
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    closeFilePicker(useFilePickerRequest().value!.token, { id: FILE, mime: 'image/png' })
    await done
    editor.commands.insertContent('!')
    expect(blocks()).toEqual([`image:${FILE}`, 'Next.!'])
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

  it('takes an uploaded replacement off the list on undo', async () => {
    mountShared(`::image{file="${OLD}" alt="Plan"}\n::`)
    fileArray(sessionDoc(), 'images').push([OLD])
    const done = replacePageFile(editor, 0)
    closeFilePicker(useFilePickerRequest().value!.token, { upload: [shot()] })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    sent[0]!.answer()
    await done
    expect(fileArray(sessionDoc(), 'images').toArray()).toEqual([FILE])
    undo(editor.state)
    expect(blocks().filter(Boolean)).toEqual([`image:${OLD}`])
    expect(fileArray(sessionDoc(), 'images').toArray()).toEqual([OLD])
  })
})
