import type { Editor } from '@tiptap/core'
import { useFileDialog } from '@vueuse/core'
import { effectScope } from 'vue'
import type * as Y from 'yjs'
import { ySyncPluginKey } from '@tiptap/y-tiptap'
import { PAGE_FILE_FIELDS, fileAccept, formatFileSize, type PageAttachment, type PageFileKey, type PageFileLimits, type PageFileLimitsByField } from '#shared/utils/files'
import { addPageFile, removePageFile } from '#shared/utils/page-files'
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

/** Opens the browser's file dialog; resolves with the chosen files, empty on cancel. */
async function pickFiles(key: PageFileKey, multiple = true): Promise<File[]> {
  const accept = fileAccept(await pageFileLimits(key))
  const scope = effectScope()
  return new Promise<File[]>((resolve) => {
    scope.run(() => {
      const dialog = useFileDialog({ accept, multiple })
      dialog.onChange(files => resolve([...(files ?? [])]))
      dialog.onCancel(() => resolve([]))
      dialog.open()
    })
  }).finally(() => scope.stop())
}

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
 * Uploads `files` into `key`, inserting one embed per file at `insertAt`,
 * followed through every edit until the uploads settle.
 * Offline refuses: the file has to reach Drupal before anything refers to it.
 */
export async function uploadIntoEditor(editor: Editor, key: PageFileKey, files: File[], insertAt: number): Promise<void> {
  if (!navigator.onLine) return refuseOffline(files)
  const at = trackRange(editor, insertAt)
  try {
    const doc = sessionDoc(editor)
    await Promise.all(files.map(async (file) => {
      const uuid = await uploadPageFile(doc, key, file)
      if (!uuid || editor.isDestroyed) return
      const node = key === 'images'
        ? { type: 'image', attrs: { file: uuid, alt: '' } }
        : { type: 'attachment', attrs: { file: uuid } }
      const pos = at.current()?.from ?? editor.state.doc.content.size
      editor.chain().insertContentAt(Math.min(pos, editor.state.doc.content.size), node).run()
    }))
  }
  finally {
    at.stop()
  }
}

/** Picks one file and uploads it as an attachment of the page. Its UUID, or null. */
export async function uploadOneAttachment(editor: Editor): Promise<string | null> {
  const files = await pickFiles('attachments', false)
  if (files.length === 0) return null
  if (!navigator.onLine) {
    refuseOffline(files)
    return null
  }
  return uploadPageFile(sessionDoc(editor), 'attachments', files[0]!)
}

/**
 * The editor's picker (ADR 0020): upload a new file, or put one of this
 * page's files or of the caller's own uploads on the page — the same file,
 * never a copy. The request state drives the `v-if` on
 * `<EditorFilePickerDialog>` in PageInlineEditor.
 */

export interface FilePickerRequest {
  /** Images only, for the image action. */
  images: boolean
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
function requestFilePick(images: boolean): Promise<FilePickerChoice | null> {
  const request = useFilePickerRequest()
  if (request.value !== null) return Promise.resolve(null)
  request.value = { images, token: ++lastToken }
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
export async function insertPageFile(editor: Editor, images: boolean, insertAt: number): Promise<void> {
  const at = trackRange(editor, insertAt)
  try {
    const choice = await requestFilePick(images)
    if (!choice || editor.isDestroyed) return
    const pos = at.current()?.from ?? editor.state.doc.content.size
    if ('upload' in choice) return await uploadIntoEditor(editor, images ? 'images' : 'attachments', choice.upload, pos)
    const key = choice.mime.startsWith('image/') ? 'images' : 'attachments'
    const doc = sessionDoc(editor)
    if (doc) addPageFile(doc, key, choice.id)
    const node = key === 'images'
      ? { type: 'image', attrs: { file: choice.id, alt: '' } }
      : { type: 'attachment', attrs: { file: choice.id } }
    editor.chain().focus().insertContentAt(Math.min(pos, editor.state.doc.content.size), node).run()
  }
  finally {
    at.stop()
  }
}

/** The node types that embed a file of each list. */
const EMBEDS: Record<PageFileKey, string[]> = {
  images: ['image'],
  attachments: ['attachment', 'attachmentInline'],
}

/**
 * Takes the embeds of a file out of the text: a card or an image goes, an
 * inline link keeps its label or, without one, `fileName`.
 */
export function removeFileEmbeds(editor: Editor, key: PageFileKey, uuid: string, fileName = ''): void {
  const { state } = editor
  const tr = state.tr
  state.doc.descendants((node, pos) => {
    if (!EMBEDS[key].includes(node.type.name) || node.attrs.file !== uuid) return
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
 * - a text edit dispatched right before or after joins the same step.
 */
export function undoableFileChange(editor: Editor, change: (doc: Y.Doc) => void): void {
  const doc = sessionDoc(editor)
  if (doc) doc.transact(() => change(doc), ySyncPluginKey)
}

/** Takes a file off the page, as one undo step: its embeds out of the text, then out of its list. */
export function removeFileFromPage(editor: Editor, key: PageFileKey, uuid: string, fileName = ''): void {
  removeFileEmbeds(editor, key, uuid, fileName)
  undoableFileChange(editor, doc => removePageFile(doc, key, uuid))
}
