import type * as Y from 'yjs'
import { serializeYDoc, type CommitContext } from './commit'
import { commentsSynced } from './collab-comments'
import { readThreads, type CommentThread } from '#shared/block-comments'
import type { FieldSpec, FieldValues } from './entity-fields'

/**
 * The working copy as a *live* session holds it — the read side of the write
 * path.
 *
 * A write through the session router does not commit while a browser peer is
 * connected: that session owns persistence and checkpoints on its own
 * schedule. So Drupal's working-copy revision is behind the document for as
 * long as somebody has the page open, and a draft read served from Drupal
 * alone would answer with content the caller may have written seconds ago and
 * seen accepted. That is the same write-then-read staleness the draft
 * subresource exists to end (OKB-92), one layer down.
 *
 * Hence: when a document is loaded for this node, its content is what the
 * draft read reports. Nothing here writes — no checkpoint is provoked by a
 * read — and nothing here decides access: the caller has already read the
 * working copy from Drupal under its own carrier, so a caller who may not see
 * a draft never reaches this code.
 */

/** A live document's content, in the shape a projection needs. */
export interface LiveContent {
  /** The body as a commit would write it (same serializer, same transforms). */
  body: string
  /** Live values of the exposed fields — only the keys the document carries. */
  fields: FieldValues
}

/** The collab document name for a node, as the session router names it. */
export function documentName(nid: number): string {
  return `node:${nid}`
}

/** The loaded document for a node, or `null` when no session holds one. */
async function loadedDocument(nid: number): Promise<Y.Doc | null> {
  let documents: Map<string, unknown> | undefined
  try {
    // Imported here, not at the top: the collab plugin's accessor reaches into
    // the Nitro app, which only exists inside the running server. A read path
    // that merely *might* consult a live session must not drag that into every
    // context importing this module.
    const { useHocuspocus } = await import('./hocuspocus')
    documents = useHocuspocus().documents as unknown as Map<string, unknown>
  }
  catch {
    // No collab server in this process — nothing is live by definition.
    return null
  }
  const doc = documents?.get(documentName(nid)) as (Y.Doc & { isLoading?: boolean }) | undefined
  return !doc || doc.isLoading ? null : doc
}

/**
 * The conversations a live session holds, or `null` when none is loaded or the
 * document has not been filled from Drupal.
 *
 * The map is only the whole truth once Drupal's own messages are in it
 * ({@link commentsSynced}) — until then the document holds a session's new
 * threads and nothing that was said before it opened, and a reader is better
 * served by Drupal's copy.
 */
export async function liveThreads(nid: number): Promise<CommentThread[] | null> {
  const doc = await loadedDocument(nid)
  return doc && commentsSynced(doc) ? readThreads(doc) : null
}

/**
 * The live content for a node, or `null` when no session is loaded for it.
 *
 * The body goes through the commit pipeline's own serializer, so what a draft
 * read reports is spelled the way the next checkpoint will write it. The title
 * heading is not part of it, here as everywhere else a body is read
 * (server/utils/title-heading.ts).
 */
export async function liveContent(nid: number, specs: FieldSpec[]): Promise<LiveContent | null> {
  const doc = await loadedDocument(nid)
  if (!doc) return null
  const docName = documentName(nid)
  // A document loads with an empty body fragment and stays that way until a
  // browser peer hydrates it (server/utils/doc-seed.ts) — a headless session
  // fills it only when a write needs it. An empty fragment is therefore "not
  // hydrated yet", not "the page is empty", and Drupal's revision is the
  // better answer.
  if (doc.getXmlFragment('default').length === 0) return null

  const ctx = {
    docName,
    nid,
    trigger: 'manual',
    identity: {},
    doc,
  } as CommitContext

  const live = doc.getMap('fields')
  const fields: FieldValues = {}
  for (const spec of specs) {
    if (live.has(spec.key)) fields[spec.key] = live.get(spec.key) as FieldValues[string]
  }
  return { body: serializeYDoc(doc, [], ctx), fields }
}
