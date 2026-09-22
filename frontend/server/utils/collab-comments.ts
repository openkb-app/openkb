import * as Y from 'yjs'
import {
  clearComments,
  commentsRoot,
  readMessages,
  readThreads,
  recordOf,
  writeComments,
  type CommentThread,
  type InlineCommentRecord,
} from '#shared/block-comments'

/**
 * The seam between a session's live conversations and Drupal's (ADR 0006).
 *
 * The live truth is the document's `comments` Y.Map; the durable side is a
 * mirror of it. Every checkpoint states the whole map, so there is nothing to
 * track: a coordinate Drupal holds and the map no longer does is dropped by
 * the same request that adds the new ones, and restating an unchanged map
 * changes nothing.
 *
 * What the map itself owes is coherence, and it gets that from the sweep the
 * body's blocks drive — a conversation about a block the page no longer
 * holds leaves the map, and the next statement takes it out of Drupal too.
 */

/**
 * What a seed is given: Drupal's messages, and the uuid of the node holding
 * the document's id now — see {@link seedComments}.
 */
export interface StoredConversations {
  uuid: string
  messages: InlineCommentRecord[]
}

/** Where the page a document's conversations belong to is recorded. */
export const META_NODE_UUID = 'node_uuid'

/** Where the fact that Drupal has been read for this document is recorded. */
const META_COMMENTS_SYNCED = 'comments_synced'

/** The whole live map, as the API names it, oldest first. */
export function commentRecords(doc: Y.Doc): InlineCommentRecord[] {
  return readMessages(doc)
    .map(recordOf)
    .filter(record => record.uid > 0)
}

/**
 * The conversations a set of stored messages describes — Drupal's copy read
 * the way a session reads its own.
 *
 * The thread assembly is the model's (`#shared/block-comments`) and is not
 * repeated here: the records go into a throwaway document and come back out
 * as threads, so a reader served from Drupal and a reader served from a live
 * session are answered by the same code.
 */
export function threadsOfRecords(records: readonly InlineCommentRecord[]): CommentThread[] {
  const doc = new Y.Doc()
  try {
    writeComments(doc, records)
    return readThreads(doc)
  }
  finally {
    doc.destroy()
  }
}

/**
 * Whether stating this document's map would be stating what it actually holds.
 *
 * A statement is a full set, so one made from a map that was never filled from
 * Drupal deletes what Drupal holds. A document can be hydrated by a peer's sync
 * without ever having been seeded — Drupal was unreachable when it loaded — and
 * that is exactly the case this refuses.
 */
export function commentsSynced(doc: Y.Doc): boolean {
  return doc.getMap('_meta').get(META_COMMENTS_SYNCED) === true
}

/** Records that Drupal's conversations have been taken into the document. */
function markCommentsSynced(doc: Y.Doc): void {
  if (commentsSynced(doc)) return
  doc.transact(() => { doc.getMap('_meta').set(META_COMMENTS_SYNCED, true) })
}

/** What a reconcile did about the document's conversations. */
export type CommentsOutcome =
  | 'seeded' // the document now holds what Drupal holds
  | 'dropped' // it belonged to another page — what it held went first

/**
 * Takes Drupal's conversations into the document.
 *
 * Runs only when no session is live. Merging rather than replacing: a message
 * the document holds and Drupal does not is one whose statement never landed,
 * and the next checkpoint states it rather than losing it.
 *
 * ## The reissued node id
 *
 * Documents are named by node id and the snapshot store outlives the nodes it
 * describes, so a document can come back attached to a DIFFERENT page than
 * the one that filled it. Seeding answers that for the body and the sidecar by
 * rewriting them; conversations need the drop to happen FIRST, because
 * {@link writeComments} leaves a coordinate that is already taken alone — two
 * pages minting the same block, thread and message id would otherwise keep
 * the foreign copy. `owner` is the uuid of the node holding the id now; a
 * document that cannot be shown to belong here is emptied before it is seeded.
 */
export function seedComments(
  doc: Y.Doc,
  owner: string,
  stored: readonly InlineCommentRecord[],
): CommentsOutcome {
  const meta = doc.getMap('_meta')
  const foreign = meta.get(META_NODE_UUID) !== owner && commentsRoot(doc).size > 0
  if (foreign) clearComments(doc)
  writeComments(doc, stored)
  doc.transact(() => { meta.set(META_NODE_UUID, owner) })
  markCommentsSynced(doc)
  return foreign ? 'dropped' : 'seeded'
}
