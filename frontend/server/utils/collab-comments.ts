import * as Y from 'yjs'
import {
  chronological,
  clearComments,
  commentsRoot,
  messageKey,
  parseMessageKey,
  readMessages,
  readThreads,
  recordOf,
  writeComments,
  type CommentMessage,
  type CommentThread,
  type InlineCommentRecord,
} from '#shared/block-comments'
import { CHAT_AGENT_LABEL, handlingLive } from '#shared/utils/chat-agent'

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

/** Who wrote to the comments map, as this server knows it — never as the client says. */
export interface CommentWriter {
  uid: number
  name: string | null
  /** Agent client's label; null for a person. */
  via: string | null
}

/** Whether a value is plain JSON data: no bigint, function, symbol or class instance anywhere in it. */
function isJson(value: unknown): boolean {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true
  if (Array.isArray(value)) return value.every(isJson)
  return typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Object.values(value as object).every(isJson)
}

/** A plain JSON object — what a seeded or stamped message is. */
function isRecord(value: unknown): value is CommentMessage {
  return isJson(value) && !!value && typeof value === 'object' && !Array.isArray(value)
}

/** A value a peer may write to the comments map: a plain JSON object with a timestamp. */
function isMessage(value: unknown): value is CommentMessage {
  return isRecord(value) && typeof value.at === 'number'
}

/**
 * Files what a write just did to the comments map under the writer behind it.
 *
 * The map is a buffer every peer writes, so the author a message carries is
 * whatever its client said; the transaction's origin is what this server
 * authenticated. For every key the write touched:
 * - another account's message it deleted or overwrote is put back, with or
 *   without a timestamp;
 * - a value that is not a plain JSON message, or under a key that is not a
 *   message's ({@link parseMessageKey}), is removed;
 * - a message naming another account, or with no writer to file it under, is
 *   removed — a peer speaks for itself only;
 * - a hand-off to another account's AI assistant is removed — an account starts
 *   its own chat only;
 * - a take on a thread ({@link refusesTake}) that is not the writer's to take
 *   is removed, and so is `handling: null` — a tab gives a take back by
 *   deleting its own;
 * - otherwise the message gets the writer's uid, name and via, and a new
 *   message or take this server's clock: message order and the thread's
 *   state never rest on a client's clock. A rewrite of the writer's own
 *   message keeps its time.
 *
 * Returns the keys of the takes it kept.
 */
export function stampCommentAuthors(
  event: Y.YMapEvent<unknown>,
  writer: CommentWriter | null,
  now: number = Date.now(),
): string[] {
  const root = event.target
  const stamped = new Map<string, CommentMessage | null>()
  const takes: string[] = []
  const clock = serverClock(root, event, now)
  for (const [key, change] of event.changes.keys) {
    const old = change.oldValue as unknown
    if (isRecord(old) && (!writer || old.uid !== writer.uid)) {
      stamped.set(key, old)
      continue
    }
    if (change.action === 'delete') continue
    const value = root.get(key)
    if (
      !isMessage(value) || !writer || !parseMessageKey(key) || (value.uid && value.uid !== writer.uid)
      || (value.assignee?.via === CHAT_AGENT_LABEL && value.assignee.uid !== writer.uid)
      || value.handling === null
      || (value.handling && refusesTake(root, key, value.handling.tab, writer.uid, now))
    ) {
      stamped.set(key, null)
      continue
    }
    if (value.handling) takes.push(key)
    const at = value.handling === undefined && isMessage(old) ? old.at : clock(value.at)
    if (
      value.uid === writer.uid && (value.name ?? null) === writer.name
      && (value.via ?? null) === writer.via && value.at === at
    ) continue
    const { via: _via, ...message } = value
    stamped.set(key, { ...message, at, uid: writer.uid, name: writer.name, ...(writer.via ? { via: writer.via } : {}) })
  }
  if (stamped.size > 0) {
    root.doc!.transact(() => {
      for (const [key, message] of stamped) {
        if (message) root.set(key, message)
        else root.delete(key)
      }
    })
  }
  return takes
}

/** The last time {@link serverClock} handed out, per document. */
const lastStamp = new WeakMap<Y.Doc, number>()

/**
 * Server times for the messages one write adds: in the order the writer gave
 * them, each later than any time handed out before on this document.
 */
function serverClock(root: Y.Map<unknown>, event: Y.YMapEvent<unknown>, now: number): (clientAt: number) => number {
  const added = [...event.changes.keys.keys()]
    .map(key => root.get(key))
    .filter(isMessage)
    .map(message => message.at)
    .sort((a, b) => a - b)
  const start = Math.max(now, (lastStamp.get(root.doc!) ?? 0) + 1)
  return (clientAt) => {
    const at = start + added.indexOf(clientAt)
    lastStamp.set(root.doc!, Math.max(at, lastStamp.get(root.doc!) ?? 0))
    return at
  }
}

/**
 * Ends the takes under `keys` that the map still holds: what the server does
 * for a tab whose connection closed, so another tab can take the thread at once.
 */
export function releaseTakes(doc: Y.Doc, keys: Iterable<string>): void {
  const root = commentsRoot(doc)
  doc.transact(() => {
    for (const key of keys) {
      const value = root.get(key)
      if (isRecord(value) && value.handling) root.delete(key)
    }
  })
}

/**
 * Whether a chat tab's take on a thread is refused: the thread is not assigned
 * to the writer's account by that account, or another tab holds a live take
 * on it. This server applies writes one at a time, so of two tabs taking at
 * once only the first keeps its take.
 */
export function refusesTake(
  root: Y.Map<unknown>,
  key: string,
  tab: string,
  uid: number,
  now: number,
): boolean {
  const at = parseMessageKey(key)
  if (!at) return true
  const prefix = key.slice(0, key.length - at.msgId.length)
  const others = [...root.entries()]
    .filter(([other, value]) => other !== key && other.startsWith(prefix) && isMessage(value))
    .map(([other, value]) => ({ ...(value as CommentMessage), id: other.slice(prefix.length) }))
    .sort(chronological)
  const assigned = others.filter(m => m.assignee !== undefined).at(-1)
  if (assigned?.assignee?.uid !== uid || assigned.uid !== uid) return true
  const took = others.filter(m => m.handling !== undefined).at(-1)
  return !!took?.handling && took.handling.tab !== tab && handlingLive(took, now)
}

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

/** Sets each stored message's text on the document where it reads differently. */
function takeStoredTexts(doc: Y.Doc, stored: readonly InlineCommentRecord[]): void {
  const root = commentsRoot(doc)
  doc.transact(() => {
    for (const record of stored) {
      const key = messageKey(record.anchor, record.thread_id, record.msg_id)
      const held = root.get(key)
      if (!isRecord(held) || typeof record.data.text !== 'string' || held.text === record.data.text) continue
      root.set(key, { ...held, text: record.data.text })
    }
  })
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
 *
 * A message's text is Drupal's where the two differ: an update on the Drupal
 * side rewrites stored text, and the snapshot has to read the same.
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
  takeStoredTexts(doc, stored)
  doc.transact(() => { meta.set(META_NODE_UUID, owner) })
  markCommentsSynced(doc)
  return foreign ? 'dropped' : 'seeded'
}
