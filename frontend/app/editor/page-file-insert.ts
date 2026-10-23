import type { Editor } from '@tiptap/core'
import { NodeSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import type * as Y from 'yjs'
import { ySyncPluginKey } from '@tiptap/y-tiptap'
import { isChangeOrigin } from '@tiptap/extension-collaboration'
import { EMBED_MIMES, PAGE_FILE_FIELDS, formatFileSize, type EmbedKind, type PageAttachment, type PageFileKey, type PageFileLimits, type PageFileLimitsByField } from '#shared/utils/files'
import { addPageFile, removePageFile, setFileHidden } from '#shared/utils/page-files'
import { trackRange } from '~/editor/tracked-range'
import { csrfToken } from '~/utils/csrf'

/**
 * Putting page files (ADR 0020) into the editor:
 * - upload: pick files, stream each to `/api/files/upload`, then put the file
 *   in the page's file list and its embed into the text. Each upload shows a
 *   toast with its progress; a refusal replaces it with an error toast, so it
 *   is announced.
 * - the picker: upload, or one of this page's files or the caller's own
 *   uploads (see below).
 */

/**
 * The upload limits of `key`, as `GET /openkb/schema` publishes them; Drupal
 * checks again. Loaded once per app, retried after a failure.
 */
export function pageFileLimits(key: PageFileKey): Promise<PageFileLimits | undefined> {
  const limits = useState<Promise<PageFileLimitsByField> | null>('okb:page-file-limits', () => null)
  limits.value ??= $fetch<{ files?: PageFileLimitsByField }>('/api/openkb/schema')
    .then(schema => schema.files ?? {}, () => {
      limits.value = null
      return {}
    })
  return limits.value.then(files => files[PAGE_FILE_FIELDS[key]])
}

let lastId = 0

/** The message a refused upload shows. */
function refusal(status: number, body: string): string {
  if (status === 413) return 'The file is too large.'
  try {
    const parsed = JSON.parse(body) as { data?: { violations?: Array<{ detail?: string }> }, statusMessage?: string }
    const detail = parsed.data?.violations?.[0]?.detail
    if (detail) return detail.replace(/^Unprocessable Entity: file validation failed\.\s*/i, '')
    if (parsed.statusMessage) return parsed.statusMessage
  }
  catch { /* not JSON */ }
  return `Upload failed (${status}).`
}

/** Streams one file to the upload route, reporting progress. Resolves with its UUID. */
async function send(file: File, key: PageFileKey, progress: (percent: number) => void): Promise<string> {
  const token = await csrfToken()
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/files/upload?field=${key}`)
    xhr.setRequestHeader('X-CSRF-Token', token)
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    xhr.setRequestHeader('Content-Disposition', `file; filename="${encodeURIComponent(file.name)}"`)
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) progress(Math.round(event.loaded / event.total * 100))
    })
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const id = (JSON.parse(xhr.responseText) as { id?: string }).id
        if (id) return resolve(id)
      }
      reject(new Error(refusal(xhr.status, xhr.responseText)))
    })
    xhr.addEventListener('error', () => reject(new Error('The connection failed.')))
    xhr.send(file)
  })
}

/** The session's Y.Doc, off the editor's Collaboration extension. */
function sessionDoc(editor: Editor): Y.Doc | null {
  const collaboration = editor.extensionManager.extensions.find(extension => extension.name === 'collaboration')
  return (collaboration?.options as { document?: Y.Doc } | undefined)?.document ?? null
}

/** Shows a refusal; an error toast stays until dismissed. */
function refuse(name: string, message: string): void {
  useToast().add({ title: `${name} was not uploaded`, description: message, color: 'error', icon: 'i-lucide-circle-alert', duration: 0 })
}

/**
 * Uploads one file into `key` and adds it to the page's list, with a toast for
 * its progress. Resolves with its UUID, or null when refused.
 */
async function uploadPageFile(doc: Y.Doc | null, key: PageFileKey, file: File): Promise<string | null> {
  const maxBytes = (await pageFileLimits(key))?.maxBytes
  if (maxBytes !== undefined && file.size > maxBytes) {
    refuse(file.name, `It is too large: the limit is ${formatFileSize(maxBytes)}.`)
    return null
  }
  const toast = useToast()
  const id = `okb-upload-${++lastId}`
  toast.add({ id, title: `Uploading ${file.name}`, description: '0%', icon: 'i-lucide-upload', duration: 0, close: false })
  let uuid: string
  try {
    uuid = await send(file, key, progress => toast.update(id, { description: `${progress}%` }))
  }
  catch (error) {
    toast.remove(id)
    refuse(file.name, (error as Error).message)
    return null
  }
  toast.remove(id)
  if (doc) addPageFile(doc, key, uuid)
  return uuid
}

/** Uploads need a connection; the text stays editable. */
function refuseOffline(files: File[]): void {
  refuse(files.map(file => file.name).join(', '), 'You are offline. Uploads need a connection; the text stays editable.')
}

/**
 * What the picker offers and the text gets: an image, a file card, or an
 * embed of an HTML file, a PDF, or either. All but images are attachments.
 */
export type FilePickKind = 'image' | 'file' | 'embed' | EmbedKind

export function pickKey(kind: FilePickKind): PageFileKey {
  return kind === 'image' ? 'images' : 'attachments'
}

/** The embed types a kind offers; null for any file. */
export function pickEmbedKinds(kind: FilePickKind): EmbedKind[] | null {
  if (kind === 'embed') return Object.keys(EMBED_MIMES) as EmbedKind[]
  return kind === 'html' || kind === 'pdf' ? [kind] : null
}

/** The node that puts a file of `kind` into the text. */
function embedNode(kind: FilePickKind, uuid: string) {
  if (kind === 'image') return { type: 'image', attrs: { file: uuid, alt: '' } }
  return { type: kind === 'file' ? 'attachment' : 'embed', attrs: { file: uuid } }
}

/**
 * Inserts the embed of a file at `pos`. A file shown as `::embed` is hidden
 * from the read page's attachments list, in the same undo step.
 */
function insertEmbed(editor: Editor, kind: FilePickKind, uuid: string, pos: number, focus = false, updateSelection = true): void {
  const chain = focus ? editor.chain().focus() : editor.chain()
  chain.insertContentAt(Math.min(pos, editor.state.doc.content.size), embedNode(kind, uuid), { updateSelection }).run()
  if (pickEmbedKinds(kind)) undoableFileChange(editor, doc => setFileHidden(doc, uuid, true))
}

/** The picker kind of each node type that shows one file. */
const NODE_KINDS: Record<string, FilePickKind> = { image: 'image', attachment: 'file', embed: 'embed' }

/**
 * The position after the embed of `uuid`; a fresh upload is embedded once.
 * - The next file goes there: a block inserted inside a paragraph lands after
 *   it, past the position it was inserted at.
 */
function endOfEmbed(editor: Editor, uuid: string): number | null {
  let end: number | null = null
  editor.state.doc.descendants((node, pos) => {
    if (end === null && node.attrs.file === uuid) end = pos + node.nodeSize
    return end === null
  })
  return end
}

/**
 * Uploads `files`, inserting one embed per file at `insertAt`, in the order
 * given, followed through every edit until the uploads settle.
 * - `kind` is one for all files, or picked per file.
 * - The embed takes the selection only if the user changed neither text nor
 *   selection meanwhile (their own undo/redo counts): typing on must not
 *   replace a selected embed.
 * - Offline refuses: the file has to reach Drupal before anything refers to it.
 */
export async function uploadIntoEditor(editor: Editor, kind: FilePickKind | ((file: File) => FilePickKind), files: File[], insertAt: number): Promise<void> {
  if (!navigator.onLine) return refuseOffline(files)
  let at = trackRange(editor, insertAt)
  let moved = false
  let inserting = false
  const follow = ({ transaction }: { transaction: Transaction }) => {
    if (inserting) return
    const own = !isChangeOrigin(transaction) || transaction.getMeta(ySyncPluginKey)?.isUndoRedoOperation
    if ((transaction.docChanged || transaction.selectionSet) && own) moved = true
  }
  editor.on('transaction', follow)
  try {
    const doc = sessionDoc(editor)
    const kinds = files.map(file => typeof kind === 'function' ? kind(file) : kind)
    const uploads = files.map((file, i) => uploadPageFile(doc, pickKey(kinds[i]!), file))
    for (const [i, upload] of uploads.entries()) {
      const uuid = await upload
      if (!uuid || editor.isDestroyed) continue
      inserting = true
      insertEmbed(editor, kinds[i]!, uuid, at.current()?.from ?? editor.state.doc.content.size, false, !moved)
      inserting = false
      const next = endOfEmbed(editor, uuid)
      if (next === null) continue
      at.stop()
      at = trackRange(editor, next)
    }
  }
  finally {
    editor.off('transaction', follow)
    at.stop()
  }
}

/**
 * The editor's picker (ADR 0020): upload a new file, or put one of this
 * page's files or of the caller's own uploads on the page — the same file,
 * never a copy. The request state drives the `v-if` on
 * `<EditorFilePickerDialog>` in PageInlineEditor.
 */

export interface FilePickerRequest {
  kind: FilePickKind
  /** Several uploads at once; Replace takes one. */
  multiple: boolean
  token: number
}

/** What the picker answers: files to upload, or the file to put on the page. */
export type FilePickerChoice = { upload: File[] } | Pick<PageAttachment, 'id' | 'mime'>

export function useFilePickerRequest() {
  return useState<FilePickerRequest | null>('okb:file-picker-request', () => null)
}

/**
 * The picker's list status. PageInlineEditor keeps its live region mounted
 * outside the modal, so the first message is announced too.
 */
export function useFilePickerStatus() {
  return useState<string>('okb:file-picker-status', () => '')
}

let settle: ((choice: FilePickerChoice | null) => void) | null = null
let lastToken = 0

/** Opens the picker; resolves with the choice or null on dismiss. */
function requestFilePick(kind: FilePickKind, multiple = true): Promise<FilePickerChoice | null> {
  const request = useFilePickerRequest()
  if (request.value !== null) return Promise.resolve(null)
  request.value = { kind, multiple, token: ++lastToken }
  return new Promise((resolve) => {
    settle = resolve
  })
}

/** Closes the picker and answers the request the token names. */
export function closeFilePicker(token: number, choice: FilePickerChoice | null): void {
  const request = useFilePickerRequest()
  if (request.value?.token !== token) return
  request.value = null
  settle?.(choice)
  settle = null
}

/**
 * Opens the picker and puts its choice on the page at `insertAt`, followed
 * through every edit while the picker is open.
 */
export async function insertPageFile(editor: Editor, kind: FilePickKind, insertAt: number): Promise<void> {
  const at = trackRange(editor, insertAt)
  try {
    const choice = await requestFilePick(kind)
    if (!choice || editor.isDestroyed) return
    const pos = at.current()?.from ?? editor.state.doc.content.size
    if ('upload' in choice) return await uploadIntoEditor(editor, kind, choice.upload, pos)
    const doc = sessionDoc(editor)
    if (doc) addPageFile(doc, pickKey(kind), choice.id)
    insertEmbed(editor, kind, choice.id, pos, true)
  }
  finally {
    at.stop()
  }
}

/**
 * Opens the file picker for one file and hands it to `link`: an upload, a file
 * on this page or one of the caller's own. A chosen file joins the page's
 * attachments only when `link` embedded it; an upload is listed anyway.
 */
export async function pickPageAttachment(editor: Editor, link: (uuid: string) => boolean): Promise<void> {
  const choice = await requestFilePick('file', false)
  if (!choice || editor.isDestroyed) return
  const doc = sessionDoc(editor)
  if (!('upload' in choice)) {
    if (link(choice.id) && doc) addPageFile(doc, 'attachments', choice.id)
    return
  }
  if (!navigator.onLine) return refuseOffline(choice.upload)
  const uuid = choice.upload[0] ? await uploadPageFile(doc, 'attachments', choice.upload[0]) : null
  if (uuid && !editor.isDestroyed) link(uuid)
}

/** The node types that embed a file of each list. */
const EMBEDS: Record<PageFileKey, string[]> = {
  images: ['image'],
  attachments: ['attachment', 'attachmentInline', 'embed'],
}

/**
 * Takes the embeds of a file in `keys` out of the text: a card or an image
 * goes, an inline link keeps its label or, without one, `fileName`.
 */
export function removeFileEmbeds(editor: Editor, keys: PageFileKey[], uuid: string, fileName = ''): void {
  const types = keys.flatMap(key => EMBEDS[key])
  const { state } = editor
  const tr = state.tr
  state.doc.descendants((node, pos) => {
    if (!types.includes(node.type.name) || node.attrs.file !== uuid) return
    const from = tr.mapping.map(pos)
    const to = tr.mapping.map(pos + node.nodeSize)
    const words = node.type.name === 'attachmentInline' ? String(node.attrs.label || fileName) : ''
    if (words) tr.replaceWith(from, to, state.schema.text(words))
    else tr.delete(from, to)
    return false
  })
  if (tr.docChanged) editor.view.dispatch(tr)
}

/**
 * Changes the session's file lists as part of the user's undo step:
 * - the UndoManager tracks the sync plugin's origin, and the lists are in
 *   its scope (`CollabHistory`);
 * - a text edit dispatched right before or after joins the same step;
 * - an empty transaction follows, so the toolbar's Undo sees the new step.
 */
export function undoableFileChange(editor: Editor, change: (doc: Y.Doc) => void): void {
  const doc = sessionDoc(editor)
  if (!doc) return
  doc.transact(() => change(doc), ySyncPluginKey)
  editor.view.dispatch(editor.state.tr)
}

/** Takes a file off the page, as one undo step: its embeds out of the text, then out of the lists `keys`. */
export function removeFileFromPage(editor: Editor, keys: PageFileKey[], uuid: string, fileName = ''): void {
  removeFileEmbeds(editor, keys, uuid, fileName)
  undoableFileChange(editor, (doc) => {
    for (const key of keys) removePageFile(doc, key, uuid)
  })
}

/** The selected image, file card or embed: its position, type, file and (an image's) width. */
export function selectedEmbed(state: EditorState): { pos: number, type: string, file: string | null, width: number | null } | null {
  const { selection } = state
  if (!(selection instanceof NodeSelection) || !NODE_KINDS[selection.node.type.name]) return null
  const { attrs, type } = selection.node
  return { pos: selection.from, type: type.name, file: (attrs.file as string | null) ?? null, width: (attrs.width as number | null) ?? null }
}

/** Whether the text still embeds `uuid` as one of `key`'s node types. */
function embeds(editor: Editor, key: PageFileKey, uuid: string): boolean {
  let found = false
  editor.state.doc.descendants((node) => {
    if (EMBEDS[key].includes(node.type.name) && node.attrs.file === uuid) found = true
    return !found
  })
  return found
}

/**
 * Swaps the file of the image, card or embed at `pos` for one the picker
 * gives: an upload, a file on this page or one of the caller's own. Alt text,
 * description, title and block id stay. The old file leaves the page's list once
 * nothing embeds it. One undo step: the swap and the list change (an upload
 * stays listed, as after undoing its insert). A new `::embed` file is hidden
 * from the read page's attachments list.
 */
export async function replacePageFile(editor: Editor, pos: number): Promise<void> {
  const node = editor.state.doc.nodeAt(pos)
  const kind = node && NODE_KINDS[node.type.name]
  if (!node || !kind) return
  const key = pickKey(kind)
  const old = node.attrs.file as string | null
  const at = trackRange(editor, pos)
  try {
    const choice = await requestFilePick(kind, false)
    if (!choice || editor.isDestroyed) return
    const doc = sessionDoc(editor)
    let uuid: string | null
    if ('upload' in choice) {
      if (!navigator.onLine) return refuseOffline(choice.upload)
      uuid = choice.upload[0] ? await uploadPageFile(doc, key, choice.upload[0]) : null
    }
    else {
      uuid = choice.id
    }
    const current = at.current()?.from
    const target = current === undefined ? null : editor.state.doc.nodeAt(current)
    if (!uuid || editor.isDestroyed || !target || target.type !== node.type || target.attrs.file !== old) return
    editor.chain().focus().command(({ tr }) => {
      tr.setNodeMarkup(current!, undefined, { ...target.attrs, file: uuid })
      return true
    }).run()
    undoableFileChange(editor, (doc) => {
      addPageFile(doc, key, uuid)
      if (node.type.name === 'embed') setFileHidden(doc, uuid, true)
      if (old && old !== uuid && !embeds(editor, key, old)) removePageFile(doc, key, old)
    })
  }
  finally {
    at.stop()
  }
}
