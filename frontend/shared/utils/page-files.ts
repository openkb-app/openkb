import type * as Y from 'yjs'
import { PAGE_FILE_FIELDS, type PageFileKey } from './files'

/**
 * The session's page files (ADR 0020): one top-level Y.Array of file UUIDs per
 * page file field, `files.attachments` and `files.images`.
 * - Top-level, so two peers attaching at once both keep their file.
 * - The checkpoint writes `field_kb_attachments` / `field_kb_images` from these only.
 */

export type PageFileLists = Record<PageFileKey, string[]>

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
      if (!wanted.has(list.get(index))) list.delete(index, 1)
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
