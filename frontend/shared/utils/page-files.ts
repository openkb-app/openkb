import * as Y from 'yjs'
import { PAGE_FILE_FIELDS, type PageFileKey } from './files'

/**
 * The session's page files (ADR 0020): one top-level Y.Array of file UUIDs per
 * page file field, `files.attachments` and `files.images`.
 * - Top-level, so two peers attaching at once both keep their file.
 * - The checkpoint writes `field_kb_attachments` / `field_kb_images` from these only.
 * - `files.hidden` holds the attachments the read page's list leaves out:
 *   `display: 0` on their field item. Taking a file off the attachments drops
 *   its flag, so a file attached again is listed.
 */

export type PageFileLists = Record<PageFileKey, string[]> & {
  /** Attachments hidden from the read page's list. Absent: none. */
  hidden?: string[]
}

export const PAGE_FILE_KEYS = Object.keys(PAGE_FILE_FIELDS) as PageFileKey[]

/** Empty lists for every page file field. */
export function emptyFileLists(): PageFileLists {
  return { attachments: [], images: [] }
}

/** The live Y.Array for a field. */
export function fileArray(doc: Y.Doc, key: PageFileKey): Y.Array<string> {
  return doc.getArray<string>(`files.${key}`)
}

/** The live lists, as plain arrays. Two peers adding one file at once count once. */
export function liveFileLists(doc: Y.Doc): PageFileLists {
  const lists = emptyFileLists()
  for (const key of PAGE_FILE_KEYS) lists[key] = [...new Set(fileArray(doc, key).toArray())]
  return lists
}

/** Adds a file to a field's list, once. */
export function addPageFile(doc: Y.Doc, key: PageFileKey, uuid: string): void {
  const list = fileArray(doc, key)
  if (!list.toArray().includes(uuid)) list.push([uuid])
}

/** Removes a file from a field's list, wherever it sits. */
export function removePageFile(doc: Y.Doc, key: PageFileKey, uuid: string): void {
  const list = fileArray(doc, key)
  doc.transact(() => {
    for (let index = list.length - 1; index >= 0; index--) {
      if (list.get(index) === uuid) list.delete(index, 1)
    }
    if (key === 'attachments') hiddenFileMap(doc).delete(uuid)
  })
}

/**
 * Makes a field's list hold `uuids`: removes the files missing from it, appends
 * the new ones. Entries a peer added meanwhile and `uuids` names stay put.
 */
export function setPageFiles(doc: Y.Doc, key: PageFileKey, uuids: string[]): void {
  const list = fileArray(doc, key)
  const wanted = new Set(uuids)
  doc.transact(() => {
    for (let index = list.length - 1; index >= 0; index--) {
      const uuid = list.get(index)
      if (wanted.has(uuid)) continue
      list.delete(index, 1)
      if (key === 'attachments') hiddenFileMap(doc).delete(uuid)
    }
    const held = new Set(list.toArray())
    const added = [...wanted].filter(uuid => !held.has(uuid))
    if (added.length > 0) list.push(added)
  })
}

/** Files to add to and take off one field's list. */
export interface PageFileChange {
  add?: string[]
  remove?: string[]
}

/**
 * Adds and removes the named files only, so a file a peer added meanwhile
 * stays. Answers whether the list changed.
 */
export function changePageFiles(doc: Y.Doc, key: PageFileKey, change: PageFileChange): boolean {
  const before = JSON.stringify(fileArray(doc, key).toArray())
  doc.transact(() => {
    for (const uuid of change.remove ?? []) removePageFile(doc, key, uuid)
    for (const uuid of change.add ?? []) addPageFile(doc, key, uuid)
  })
  return JSON.stringify(fileArray(doc, key).toArray()) !== before
}

/** The live hidden flags: file UUID → true. */
export function hiddenFileMap(doc: Y.Doc): Y.Map<boolean> {
  return doc.getMap<boolean>('files.hidden')
}

/** The attachments hidden from the read page's list, in list order. */
export function liveHiddenFiles(doc: Y.Doc): string[] {
  const hidden = hiddenFileMap(doc)
  return liveFileLists(doc).attachments.filter(uuid => hidden.get(uuid) === true)
}

/** Hides an attachment from the read page's list, or shows it again. */
export function setFileHidden(doc: Y.Doc, uuid: string, hidden: boolean): void {
  const map = hiddenFileMap(doc)
  if (hidden && map.get(uuid) !== true) map.set(uuid, true)
  else if (!hidden && map.has(uuid)) map.delete(uuid)
}

/** Sets the flag of each of `attachments`: hidden when `hidden` names it. */
export function setHiddenFiles(doc: Y.Doc, attachments: string[], hidden: string[]): void {
  doc.transact(() => {
    for (const uuid of attachments) setFileHidden(doc, uuid, hidden.includes(uuid))
  })
}

/** The files the session's text shows as `::embed`. */
export function embeddedFiles(doc: Y.Doc): Set<string> {
  const found = new Set<string>()
  const embeds = doc.getXmlFragment('default').createTreeWalker(node => node instanceof Y.XmlElement && node.nodeName === 'embed')
  for (const node of embeds) {
    const file = (node as Y.XmlElement).getAttribute('file')
    if (typeof file === 'string') found.add(file)
  }
  return found
}
