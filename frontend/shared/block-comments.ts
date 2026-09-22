import * as Y from 'yjs'

/**
 * Inline comments (OKB-121) — the data model.
 *
 * A comment is a conversation ABOUT a block, never content of it, and never a
 * fact about it either. It therefore lives in a root map of its own on the
 * session document:
 *
 *   comments: Y.Map
 *     └─ "<blockId>\0<threadId>:<msgId>" → CommentMessage
 *
 * ## Why not the review sidecar
 *
 * The `blockMeta` sidecar next door holds only what a SERVER witnessed — a
 * contributor recorded from a write, an approval recorded against an
 * authenticated request — and Drupal refuses every client-supplied byte of it
 * (`openkb_agent_entity_field_access()`). A comment is the opposite kind of
 * value: its author is whoever typed it, stated by the client that did, and
 * nothing about it is derivable from a diff. Putting the two in one container
 * would mean either weakening the field the gate's trust rests on, or
 * inventing a server-witnessed write path for a note that gates nothing. A
 * container of its own costs neither.
 *
 * ## One key per MESSAGE
 *
 * The reason the contributor records have one key per actor: a Y.Map merges
 * per key and nothing else. Two editors replying to the same thread at the
 * same moment each set a key only they write, so both replies survive; a
 * thread held as one value under its thread id would keep whichever reply
 * landed last. A per-message key is only ever set, never created-then-appended,
 * so there is no window in which one author's first message can lose to
 * another's.
 *
 * ## Resolution
 *
 * Resolving is itself a message — a state-bearing one, carrying `resolved`
 * instead of text. The thread stands as whatever its LATEST such message says,
 * so a resolve and a concurrent reply merge into "replied after resolving"
 * rather than one erasing the other, and reopening needs no second mechanism.
 *
 * ## Assignment
 *
 * Whose thread it is works the same way: a message carrying `assignee` instead
 * of text, latest wins, `null` unassigns. It rides the same opaque `data` map,
 * so Drupal, revisions and the checkpoint mirror need nothing for it.
 *
 * ## Reach
 *
 * Threads reach the editors of a document and nobody else. They ride the
 * session document, and every checkpoint states the whole map to Drupal, which
 * files them beside the page behind a route that answers to update access
 * (ADR 0006).
 * They are absent from every published surface by construction rather than by
 * filtering: the read page is served the derived projection of
 * `field_block_meta` (bylines and sign-offs), and the publish gate reads the
 * review flags. An unresolved comment neither shows on the live page nor holds
 * publication back.
 *
 * ## Whose conversation it is
 *
 * Documents are named by node id, so a conversation is bound to the store's
 * coupling with the database that issued the id — which environments keep
 * coherent (ADR 0008): reinstalling or restoring the database wipes or
 * restores the store with it. The code does not defend against skew.
 */

/** The root comment map of a session document. */
export function commentsRoot(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap('comments')
}


/** Separates the block id from the message coordinates; a block id holds no NUL. */
const BLOCK_SEPARATOR = '\u0000'

/**
 * Where in the block a thread was opened.
 *
 * Both halves are kept on purpose. The offsets say where the reader was
 * looking; the quoted text says what they were looking AT, and it is the half
 * that survives an edit somewhere else in the block. Neither is authoritative
 * alone — see {@link resolveAnchor}.
 */
export interface CommentAnchor {
  /** Character offset of the selection start within the block's text. */
  from: number
  /** Character offset of the selection end. */
  to: number
  /** The text that was selected, as it read when the thread was opened. */
  quote: string
}

/**
 * Whoever a thread is assigned to — a person, or an agent by the identity it
 * holds in the session (`via`, so Ada's Claude is that account's agent and not
 * the person).
 */
export interface CommentAssignee {
  uid: number | null
  name: string
  /** Agent client's label; absent for a person. */
  via?: string | null
}

/** One message of one thread, as the document stores it. */
export interface CommentMessage {
  uid: number | null
  /** Display name captured at write time, so the thread reads without a lookup. */
  name?: string | null
  /** Agent client's label an agent said it under; absent for a human. */
  via?: string | null
  /** Wall-clock ms of the write. */
  at: number
  /** What was said. Absent on a state-bearing message. */
  text?: string
  /**
   * The range this thread is about. Carried by the message that opened the
   * thread; a reply speaks about the same range and repeats nothing.
   */
  anchor?: CommentAnchor
  /** A state-bearing message: the thread's standing from here on. */
  resolved?: boolean
  /** A state-bearing message: whose thread it is from here on, `null` for nobody's. */
  assignee?: CommentAssignee | null
}

/** One message with the id it is stored under. */
export interface StoredMessage extends CommentMessage {
  id: string
}

/** A thread as the drawer and the marks read it. */
export interface CommentThread {
  blockId: string
  threadId: string
  /** The opening message's anchor, or null for a block-level thread. */
  anchor: CommentAnchor | null
  /** The text-bearing messages, oldest first. */
  messages: StoredMessage[]
  resolved: boolean
  /** Whose thread it is, per the latest assignment; null for nobody's. */
  assignee: CommentAssignee | null
  /**
   * Everybody the thread has been handed to, oldest first. A mention is read
   * back by whoever the thread has named, and a reassignment does not unname
   * the agent the message before it was written about.
   */
  assignedTo: CommentAssignee[]
  /** Who made that assignment, and when — what the thread's log line names. */
  assignedBy: { name: string | null, via: string | null, at: number } | null
  /** When the thread was opened — its order among the block's threads. */
  openedAt: number
  /** The latest activity of any kind, including resolving. */
  lastAt: number
}

/** The key one message is held under. */
export function messageKey(blockId: string, threadId: string, msgId: string): string {
  return `${blockId}${BLOCK_SEPARATOR}${threadId}:${msgId}`
}

/**
 * The block, thread and message a key names, or null when the key is not a
 * message. A malformed key is not one either — ids are minted by
 * {@link mintCommentId} and carry no colon.
 */
export function parseMessageKey(
  key: string,
): { blockId: string, threadId: string, msgId: string } | null {
  const at = key.indexOf(BLOCK_SEPARATOR)
  if (at <= 0) return null
  const blockId = key.slice(0, at)
  const [threadId, msgId, ...rest] = key.slice(at + BLOCK_SEPARATOR.length).split(':')
  if (!threadId || !msgId || rest.length > 0) return null
  return { blockId, threadId, msgId }
}

/** A fresh thread or message id (`c-<hex>` / `m-<hex>`); colon-free by construction. */
export function mintCommentId(prefix: 'c' | 'm', random: () => number = Math.random): string {
  return `${prefix}-${Math.floor(random() * 0x1_0000_0000).toString(16).padStart(8, '0')}`
}

/**
 * Records one message, in a key of its own — so two editors writing to the
 * same thread, or to the same block, merge instead of one losing the other. A
 * message is written once and never rewritten; resolving the thread is another
 * message, not an edit.
 */
export function recordCommentMessage(
  doc: Y.Doc,
  blockId: string,
  threadId: string,
  msgId: string,
  message: CommentMessage,
): void {
  const root = commentsRoot(doc)
  doc.transact(() => {
    root.set(messageKey(blockId, threadId, msgId), message)
  })
}

/** Messages in the order they were written; the key breaks a tie in the clock. */
function chronological(a: StoredMessage, b: StoredMessage): number {
  return a.at - b.at || (a.id < b.id ? -1 : 1)
}

/**
 * Every thread on the document, oldest thread first.
 *
 * A thread with no text-bearing message at all is dropped: nothing was said,
 * and a resolve-only entry is the residue of a thread whose messages were
 * swept, not a conversation.
 */
export function readThreads(doc: Y.Doc): CommentThread[] {
  const byThread = new Map<string, { blockId: string, threadId: string, all: StoredMessage[] }>()
  for (const [key, value] of commentsRoot(doc).entries()) {
    const parsed = parseMessageKey(key)
    if (!parsed || !value || typeof value !== 'object') continue
    const at = `${parsed.blockId}${BLOCK_SEPARATOR}${parsed.threadId}`
    const group = byThread.get(at)
      ?? { blockId: parsed.blockId, threadId: parsed.threadId, all: [] }
    group.all.push({ ...(value as CommentMessage), id: parsed.msgId })
    byThread.set(at, group)
  }

  const threads: CommentThread[] = []
  for (const { blockId, threadId, all } of byThread.values()) {
    const ordered = all.sort(chronological)
    const messages = ordered.filter(m => typeof m.text === 'string' && m.text !== '')
    if (messages.length === 0) continue
    const stated = ordered.filter(m => typeof m.resolved === 'boolean')
    const assignments = ordered.filter(m => m.assignee !== undefined)
    const assigned = assignments.at(-1) ?? null
    threads.push({
      blockId,
      threadId,
      anchor: ordered.find(m => m.anchor)?.anchor ?? null,
      messages,
      resolved: stated.length > 0 ? stated[stated.length - 1]!.resolved === true : false,
      assignee: assigned?.assignee ?? null,
      assignedTo: assignments.flatMap(m => m.assignee ?? []),
      assignedBy: assigned
        ? { name: assigned.name ?? null, via: assigned.via ?? null, at: assigned.at }
        : null,
      openedAt: ordered[0]!.at,
      lastAt: ordered[ordered.length - 1]!.at,
    })
  }
  return threads.sort((a, b) => a.openedAt - b.openedAt || (a.threadId < b.threadId ? -1 : 1))
}

/** Unresolved threads on one block — what the editor marks the block for. */
export function openThreads(threads: CommentThread[], blockId: string): CommentThread[] {
  return threads.filter(t => t.blockId === blockId && !t.resolved)
}

/**
 * Drops the messages of every block absent from `presentIds` — the same
 * coherence sweep the sidecar gets, for the same reason: a conversation about
 * a block nobody can read is one nobody can answer.
 */
export function pruneComments(doc: Y.Doc, presentIds: Set<string>): void {
  const root = commentsRoot(doc)
  doc.transact(() => {
    for (const key of [...root.keys()]) {
      const parsed = parseMessageKey(key)
      if (!parsed || !presentIds.has(parsed.blockId)) root.delete(key)
    }
  })
}

/**
 * Where a thread's anchor points in the block as it reads NOW, or null when
 * the range can no longer be found — which degrades the thread to block-level
 * rather than dropping it.
 *
 * The stored offsets are tried first, so a repeated word stays anchored where
 * the reader put it. When the text there has changed, the quote is searched
 * for once: an edit ELSEWHERE in the block moves the range without changing
 * what it is about, and following it is the whole reason the quote is stored.
 * A quote that no longer occurs is content that has been rewritten under the
 * conversation, and pointing at whatever now sits at those offsets would be a
 * worse answer than pointing at the block.
 */
export function resolveAnchor(
  anchor: CommentAnchor | null | undefined,
  text: string,
): { from: number, to: number } | null {
  if (!anchor || !anchor.quote) return null
  const { from, to, quote } = anchor
  if (text.slice(from, to) === quote) return { from, to }
  const at = text.indexOf(quote)
  return at === -1 ? null : { from: at, to: at + quote.length }
}

/**
 * One message as the inline-comment API names it.
 *
 * The coordinates are hoisted out; everything else the live map holds rides
 * `data`, which Drupal stores and serves back unread. `anchor` here is the
 * block — the range a thread was opened on is the message's own `anchor`,
 * inside `data`.
 */
export interface InlineCommentRecord {
  anchor: string
  thread_id: string
  msg_id: string
  uid: number
  data: CommentMessage
}

/** Every message on the document, with its coordinates, oldest first. */
export function readMessages(doc: Y.Doc): Array<CommentMessage & { key: string, blockId: string, threadId: string, msgId: string }> {
  const messages = []
  for (const [key, value] of commentsRoot(doc).entries()) {
    const parsed = parseMessageKey(key)
    if (!parsed || !value || typeof value !== 'object') continue
    messages.push({ ...(value as CommentMessage), key, ...parsed })
  }
  return messages.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1))
}

/** One live message as a record — the same value, with its coordinates lifted out. */
export function recordOf(
  message: CommentMessage & { key?: string, blockId: string, threadId: string, msgId: string },
): InlineCommentRecord {
  const { key, blockId, threadId, msgId, ...data } = message
  return { anchor: blockId, thread_id: threadId, msg_id: msgId, uid: data.uid ?? 0, data }
}

/**
 * Writes stored records into the document, leaving anything already there.
 *
 * Leaving rather than overwriting is not an optimization: a message is written
 * once on both sides and never rewritten, so a coordinate that holds something
 * holds the same thing — and re-setting it would churn the CRDT for every
 * connected peer on every reconcile.
 *
 * `uid` comes off the record rather than out of `data`: it is the one thing
 * Drupal decides rather than stores.
 */
export function writeComments(doc: Y.Doc, records: readonly InlineCommentRecord[]): void {
  const root = commentsRoot(doc)
  doc.transact(() => {
    for (const record of records) {
      const key = messageKey(record.anchor, record.thread_id, record.msg_id)
      if (root.has(key)) continue
      root.set(key, { ...record.data, uid: record.uid })
    }
  })
}

/** Drops every conversation the document holds. */
export function clearComments(doc: Y.Doc): void {
  const root = commentsRoot(doc)
  doc.transact(() => {
    for (const key of [...root.keys()]) root.delete(key)
  })
}
