import type * as Y from 'yjs'
import { PAGE_FILE_FIELDS } from '#shared/utils/files'
import {
  PAGE_FILE_KEYS,
  emptyFileLists,
  liveFileLists,
  removePageFile,
  setPageFiles,
  type PageFileLists,
} from '#shared/utils/page-files'
import type { CommitContext, CommitHooks } from './commit'

/**
 * The page files in the commit payload (ADR 0020).
 * - A list that moved off `_meta.files_baseline` goes out as the field.
 * - Drupal answers with the files it kept; the baseline advances to that, and
 *   a dropped file leaves the live list too.
 */

/** What Drupal held at seed time or after the last commit. Null before a seed. */
export function filesBaseline(doc: Y.Doc): PageFileLists | null {
  return (doc.getMap('_meta').get('files_baseline') as PageFileLists | undefined) ?? null
}

/** Brings the lists in line with Drupal and records the baseline. */
export function seedFiles(doc: Y.Doc, values: PageFileLists): void {
  doc.transact(() => {
    for (const key of PAGE_FILE_KEYS) setPageFiles(doc, key, values[key])
    doc.getMap('_meta').set('files_baseline', values)
  })
}

/** The page file lists out of a CE page's props (`attachments`, `images`). */
export function ceFileLists(props: Record<string, unknown>): PageFileLists {
  const lists = emptyFileLists()
  for (const key of PAGE_FILE_KEYS) {
    const raw = props[key]
    const items = Array.isArray(raw) ? raw : raw ? [raw] : []
    lists[key] = items.flatMap(item => typeof item?.uuid === 'string' ? [item.uuid as string] : [])
  }
  return lists
}

/** Fields whose live list moved off the baseline. None before a seed. */
export function dirtyFileKeys(doc: Y.Doc): Array<keyof PageFileLists> {
  const baseline = filesBaseline(doc)
  if (!baseline) return []
  const live = liveFileLists(doc)
  return PAGE_FILE_KEYS.filter(key => JSON.stringify(live[key]) !== JSON.stringify(baseline[key] ?? []))
}

/** Whether a file the baseline lacks is in the lists — an upload to commit. */
export function hasNewFile(doc: Y.Doc): boolean {
  const baseline = filesBaseline(doc)
  if (!baseline) return false
  const live = liveFileLists(doc)
  return PAGE_FILE_KEYS.some(key => live[key].some(uuid => !(baseline[key] ?? []).includes(uuid)))
}

interface FilesCapture {
  dirty: Array<keyof PageFileLists>
  live: PageFileLists
}

const captures = new WeakMap<CommitContext, FilesCapture>()

function captured(ctx: CommitContext): FilesCapture {
  let capture = captures.get(ctx)
  if (!capture) {
    capture = { dirty: dirtyFileKeys(ctx.doc), live: liveFileLists(ctx.doc) }
    captures.set(ctx, capture)
  }
  return capture
}

/** The commit pipeline's page file lane. */
export function filesCommitHooks(): Pick<CommitHooks, 'captures' | 'dirtyChecks' | 'payloadExtenders' | 'postCommit'> {
  return {
    captures: [ctx => void captured(ctx)],

    dirtyChecks: [ctx => captured(ctx).dirty.length > 0],

    payloadExtenders: [(extra, ctx) => {
      const { dirty, live } = captured(ctx)
      if (dirty.length === 0) return extra
      const relationships = { ...(extra.relationships ?? {}) }
      for (const key of dirty) {
        relationships[PAGE_FILE_FIELDS[key]] = { data: live[key].map(id => ({ type: 'file--file', id })) }
      }
      return { ...extra, relationships }
    }],

    postCommit: [(result, ctx) => {
      const { dirty, live } = captured(ctx)
      if (!result.committed || dirty.length === 0) return
      const baseline = { ...(filesBaseline(ctx.doc) ?? emptyFileLists()) }
      ctx.doc.transact(() => {
        for (const key of dirty) {
          const kept = result.files?.[PAGE_FILE_FIELDS[key]] ?? live[key]
          baseline[key] = kept
          for (const uuid of live[key]) {
            if (!kept.includes(uuid)) removePageFile(ctx.doc, key, uuid)
          }
        }
        ctx.doc.getMap('_meta').set('files_baseline', baseline)
      })
    }],
  }
}
