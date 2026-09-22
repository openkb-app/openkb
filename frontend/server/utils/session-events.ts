import * as Y from 'yjs'
import type { Node as PMNode } from '@tiptap/pm/model'
import { initProseMirrorDoc, relativePositionToAbsolutePosition } from '@tiptap/y-tiptap'
import { editorSchema } from './editor-schema'
import { blockSegmentsOfDoc, blockVersion } from './block-versions'
import { writerOfOrigin, type WriterRef } from './collab-attribution'
import { COLLAB_BLOCK_SETTLE_MS, COLLAB_PRESENCE_SETTLE_MS } from './collab-timing'
import { blockIdOf } from '#shared/page-blocks'
import { parseMessageKey, readThreads, type CommentThread } from '#shared/block-comments'
import type { ProseMirrorJSON } from './commit'
import type { AwareDoc } from './agent-awareness'
import type { AwarenessUser } from '#shared/utils/presence'

/**
 * What happened in one editing session, as `waitForChanges` reports it.
 *
 * A watcher is connected to nothing between two calls, so a watched document
 * keeps a capped append-only log ({@link LOG_LIMIT}) and every answer carries
 * the cursor the next call resumes from. Blocks and presence are reported once
 * they settle: that bounds the cost, and a paragraph is actionable where a
 * keystroke is not.
 */

/** The kinds of change a watcher can ask for. */
export const CHANGE_KINDS = ['comments', 'blocks', 'presence'] as const
export type ChangeKind = (typeof CHANGE_KINDS)[number]

/** How many events one document's log holds before the oldest fall off. */
const LOG_LIMIT = 500

/** Who a peer is, as an event names them. */
export interface EventPeer {
  uid: number | null
  name: string | null
  /** Agent client's label — set exactly when the peer is an agent. */
  via: string | null
}

/** A thread was opened, replied to or resolved. */
export interface CommentsEvent {
  kind: 'comments'
  thread: CommentThread
  /** Who caused it — a resolve bears no message, so the thread cannot say. */
  by: EventPeer | null
}

/** A block went quiet after being changed, or left the page. */
export interface BlocksEvent {
  kind: 'blocks'
  event: 'settled' | 'removed'
  blockId: string
  /** What the block now holds — null once it is gone. */
  version: string | null
  markdown: string | null
  /** Null when the settle window saw more than one writer, or none we know. */
  by: EventPeer | null
}

/** Somebody joined, left, or moved to another block. */
export interface PresenceEvent {
  kind: 'presence'
  event: 'joined' | 'left' | 'moved'
  who: EventPeer
  /** The block they are in, or null when they are in none. */
  blockId: string | null
  /** The awareness client this is about — a watcher's own is filtered out. */
  clientId: number
}

/**
 * The session ended. Terminal: a watcher reading one stops looping rather than
 * waiting on a document that is no longer there.
 */
export interface SessionEvent {
  kind: 'session'
  event: 'closed'
  reason: 'no-editors' | 'unloaded'
}

export type ChangeBody = CommentsEvent | BlocksEvent | PresenceEvent | SessionEvent

/** One logged event: what happened, when, and where it sits in the log. */
export type ChangeEvent = ChangeBody & { at: number, cursor: string }

/** What a watcher is handed: what it missed, and where to resume. */
export interface ChangeAnswer {
  events: ChangeEvent[]
  cursor: string
  /** The log the cursor named is gone; nothing from before this answer survives. */
  restarted: boolean
  /** The log overran while the watcher was away, so some events fell off it. */
  dropped: boolean
  /** Browser peers in the room, so "quiet" and "nobody here" differ. */
  editors: number
}

/** Whose events are the reader's own, and so not news to it. */
export interface Reader {
  /** Its awareness client id. */
  clientId?: number
  /** The account it writes under. */
  uid?: number | null
  /** Its agent label — a human on the same account carries none. */
  via?: string | null
}

/** The document a log watches, narrowed so a test can stand one up. */
export interface WatchTarget {
  documentName: string
  doc: AwareDoc
  /** Browser peers connected — an agent's own session is not one. */
  humanPeers: () => number
}

export interface WatchOptions {
  /** Body quiet window before a changed block is reported. */
  settleMs?: number
  /** Awareness quiet window before joins, leaves and moves are reported. */
  presenceMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

/** A peer as of the last presence settle. */
interface WatchedPeer {
  who: EventPeer
  blockId: string | null
}

/** One document's log, and the observers feeding it. */
export interface SessionWatch {
  documentName: string
  /** Identifies this log's numbering; a cursor from another one is unusable. */
  epoch: string
  /** The sequence the next event will carry. */
  next: number
  events: ChangeEvent[]
  /** Woken by every event — one call, one wake-up. */
  waiters: Set<() => void>
  closed: boolean
  /** Browser peers in the room right now. */
  humanPeers: () => number
  /** This log's clock, so a cursor names a moment the document knows too. */
  now: () => number
  stop: () => void
}

const watches = new Map<string, SessionWatch>()

/**
 * The cursor naming a position in one log, and the moment it names.
 *
 * The time is what a reader can compare the document against: a log lives in
 * one process's memory and a conversation lives in the document, so a caller
 * asks the document what changed since this moment rather than trusting the
 * log to have witnessed it.
 */
function cursorAt(watch: SessionWatch, seq: number, at: number): string {
  return `${watch.epoch}:${seq}:${at}`
}

/**
 * Whether a cursor is shaped like one an answer returned
 * (`<epoch>:<seq>:<at>`). Garbage is refused by the caller rather than read as
 * a replaced log.
 */
export function isCursorShaped(cursor: string): boolean {
  const [epoch, seq, at, ...rest] = cursor.split(':')
  return !!epoch && rest.length === 0 && /^\d+$/.test(seq ?? '') && /^\d+$/.test(at ?? '')
}

/** The moment a cursor names, or null when it names none. */
function timeOf(cursor: string | undefined): number | null {
  if (cursor === undefined || !isCursorShaped(cursor)) return null
  return Number(cursor.split(':')[2])
}

/** The sequence a cursor names in this log, or null when it names another. */
function seqOf(watch: SessionWatch, cursor: string | undefined): number | null {
  if (cursor === undefined || !isCursorShaped(cursor)) return null
  const [epoch, seq] = cursor.split(':')
  return epoch === watch.epoch ? Number(seq) : null
}

/**
 * Whether a document change stamped `at` may have come after `cursor`.
 *
 * - Before the cursor's millisecond: no. After it, or no cursor: yes.
 * - In the cursor's own millisecond the clock cannot tell. A live log still
 *   holding everything after the cursor reports such a change itself, so it
 *   counts as new only where the log cannot.
 */
export function isAfterCursor(watch: SessionWatch, cursor: string | undefined, at: number): boolean {
  const since = timeOf(cursor)
  if (since === null || at > since) return true
  if (at < since) return false
  const from = seqOf(watch, cursor)
  return from === null || watch.closed || watch.next - from > watch.events.length
}

/** The account behind an awareness state, as an event names it. */
function peerOfState(user: AwarenessUser | undefined): EventPeer {
  return {
    uid: typeof user?.uid === 'number' ? user.uid : null,
    name: user?.name ?? null,
    via: user?.via ?? null,
  }
}

/** The block a position sits in, or null when it resolves outside one. */
function blockAtPosition(pm: PMNode, pos: number): string | null {
  if (pos < 0 || pos > pm.content.size) return null
  const resolved = pm.resolve(pos)
  return resolved.depth === 0 ? null : blockIdOf(resolved.node(1))
}

/** The awareness state of one peer, as far as this module reads it. */
interface PeerState {
  user?: AwarenessUser
  cursor?: { anchor?: unknown }
  claim?: { blocks?: string[] }
}

/** The document as ProseMirror, plus the Y↔PM mapping caret positions need. */
type DocView = { pm: PMNode, mapping: ReturnType<typeof initProseMirrorDoc>['mapping'] }

/**
 * Where a peer is working.
 *
 * A browser peer publishes a Y.js relative position, so its block is resolved
 * against the document as it stands now. An agent has no caret and publishes
 * the blocks its last write touched; the first of them is where it is.
 */
function blockOfState(doc: Y.Doc, view: DocView, state: PeerState): string | null {
  const claimed = state.claim?.blocks?.[0]
  if (claimed) return claimed
  const anchor = state.cursor?.anchor
  if (!anchor) return null
  try {
    const pos = relativePositionToAbsolutePosition(
      doc,
      doc.getXmlFragment('default'),
      Y.createRelativePositionFromJSON(anchor),
      view.mapping,
    )
    return pos === null ? null : blockAtPosition(view.pm, pos)
  }
  catch {
    // A position anchored in content this document no longer holds resolves
    // nowhere; the peer is reported without a block rather than not at all.
    return null
  }
}

/**
 * Starts watching a document, or answers the watch already on it.
 *
 * Idempotent per document: two agents on one page share one log and one set of
 * observers, and each filters the log for itself as it reads.
 */
export function watchSession(target: WatchTarget, options: WatchOptions = {}): SessionWatch {
  const existing = watches.get(target.documentName)
  if (existing && !existing.closed) {
    // The count is read through whoever asked last: the first watcher's session
    // may be gone while the log it started is still being read.
    existing.humanPeers = target.humanPeers
    return existing
  }

  const now = options.now ?? (() => Date.now())
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? (handle => clearTimeout(handle))
  const { doc } = target

  const watch: SessionWatch = {
    documentName: target.documentName,
    epoch: Math.floor(Math.random() * 0x1_0000_0000).toString(16),
    next: 0,
    events: [],
    waiters: new Set(),
    closed: false,
    humanPeers: target.humanPeers,
    now,
    stop: () => {},
  }

  /** Appends one event and wakes whoever is waiting. */
  function record(at: number, body: ChangeBody): void {
    watch.events.push({ ...body, at, cursor: cursorAt(watch, watch.next, at) })
    watch.next += 1
    if (watch.events.length > LOG_LIMIT) watch.events.splice(0, watch.events.length - LOG_LIMIT)
    for (const wake of [...watch.waiters]) wake()
  }

  /**
   * The document as ProseMirror, rebuilt only when the body has moved.
   *
   * The conversion is this module's expensive step and both the block diff and
   * every caret resolution need it, so one is shared until the next edit.
   */
  let view: DocView | null = null
  const docView = (): DocView => {
    if (!view) {
      const { doc: pm, mapping } = initProseMirrorDoc(doc.getXmlFragment('default'), editorSchema)
      view = { pm, mapping }
    }
    return view
  }

  const segments = (): Map<string, string> =>
    blockSegmentsOfDoc(docView().pm.toJSON() as ProseMirrorJSON)

  const peersNow = (): Map<number, WatchedPeer> => {
    const current = new Map<number, WatchedPeer>()
    for (const [clientId, state] of doc.awareness.getStates()) {
      const peer = (state ?? {}) as PeerState
      current.set(clientId, { who: peerOfState(peer.user), blockId: blockOfState(doc, docView(), peer) })
    }
    return current
  }

  // The blocks and peers already there are the baseline the diffs run against.
  let blocks = segments()
  let peers = peersNow()
  let hadEditors = watch.humanPeers() > 0
  /** Who wrote into the body since the last block settle. */
  let writers: EventPeer[] = []

  /** Reports every block that moved and went quiet, and every one that went. */
  function settleBlocks(): void {
    const current = segments()
    const at = now()
    // Attribution is per settle window, not per block: two peers writing
    // different blocks inside one window leave it unattributed rather than
    // crediting the wrong one.
    const by = writers.length === 1 ? writers[0]! : null
    for (const [id, markdown] of current) {
      if (blocks.get(id) === markdown) continue
      record(at, {
        kind: 'blocks', event: 'settled', blockId: id, version: blockVersion(markdown), markdown, by,
      })
    }
    for (const id of blocks.keys()) {
      if (current.has(id)) continue
      record(at, { kind: 'blocks', event: 'removed', blockId: id, version: null, markdown: null, by })
    }
    blocks = current
    writers = []
  }

  /**
   * Reports who arrived, left and moved since the last settle — and, when the
   * last human left, that the session is over.
   */
  function settlePresence(): void {
    const current = peersNow()
    const at = now()
    for (const [clientId, peer] of current) {
      const before = peers.get(clientId)
      if (!before) {
        record(at, { kind: 'presence', event: 'joined', who: peer.who, blockId: peer.blockId, clientId })
      }
      else if (before.blockId !== peer.blockId) {
        record(at, { kind: 'presence', event: 'moved', who: peer.who, blockId: peer.blockId, clientId })
      }
    }
    for (const [clientId, peer] of peers) {
      if (!current.has(clientId)) {
        record(at, { kind: 'presence', event: 'left', who: peer.who, blockId: null, clientId })
      }
    }
    peers = current

    // The humans are what a watcher is here for: when the last one goes, the
    // loop is told rather than left waiting on an empty room.
    const editors = watch.humanPeers() > 0
    if (hadEditors && !editors) record(at, { kind: 'session', event: 'closed', reason: 'no-editors' })
    hadEditors = editors
  }

  /** One pending settle per lane, restarted by every change it is about. */
  let blockTimer: ReturnType<typeof setTimeout> | null = null
  let presenceTimer: ReturnType<typeof setTimeout> | null = null

  function schedulePresence(): void {
    if (presenceTimer) clearTimer(presenceTimer)
    presenceTimer = setTimer(() => {
      presenceTimer = null
      settlePresence()
    }, options.presenceMs ?? COLLAB_PRESENCE_SETTLE_MS)
    ;(presenceTimer as { unref?: () => void }).unref?.()
  }

  /** A writer as an event names them; the display name comes from the peer list. */
  const peerOfWriter = (wrote: WriterRef): EventPeer => ({
    uid: wrote.uid,
    name: [...peers.values()].find(peer => peer.who.uid === wrote.uid)?.who.name ?? null,
    via: wrote.via,
  })

  const onUpdate = (_update: Uint8Array, origin: unknown): void => {
    view = null
    const wrote = writerOfOrigin(origin)
    if (wrote && !writers.some(seen => seen.uid === wrote.uid && seen.via === wrote.via)) {
      writers.push(peerOfWriter(wrote))
    }
    if (blockTimer) clearTimer(blockTimer)
    blockTimer = setTimer(() => {
      blockTimer = null
      settleBlocks()
    }, options.settleMs ?? COLLAB_BLOCK_SETTLE_MS)
    ;(blockTimer as { unref?: () => void }).unref?.()
    // Content moving moves the carets in it, so presence re-settles with the
    // body and not only when an awareness message arrives.
    schedulePresence()
  }

  /** A thread is reported whole, however many of its messages just landed. */
  const onComments = (event: Y.YMapEvent<unknown>): void => {
    const at = now()
    const threads = readThreads(doc)
    const reported = new Set<string>()
    const wrote = writerOfOrigin(event.transaction.origin)
    const by = wrote ? peerOfWriter(wrote) : null
    for (const key of event.keysChanged) {
      const coordinates = parseMessageKey(key)
      if (!coordinates || reported.has(coordinates.threadId)) continue
      const thread = threads.find(candidate =>
        candidate.blockId === coordinates.blockId && candidate.threadId === coordinates.threadId)
      if (!thread) continue
      reported.add(thread.threadId)
      record(at, { kind: 'comments', thread, by })
    }
  }

  const onDestroy = (): void => {
    record(now(), { kind: 'session', event: 'closed', reason: 'unloaded' })
    watch.stop()
  }

  doc.on('update', onUpdate)
  doc.on('destroy', onDestroy)
  doc.getMap('comments').observe(onComments)
  doc.awareness.on('update', schedulePresence)

  watch.stop = (): void => {
    if (watch.closed) return
    watch.closed = true
    if (blockTimer) clearTimer(blockTimer)
    if (presenceTimer) clearTimer(presenceTimer)
    doc.off('update', onUpdate)
    doc.off('destroy', onDestroy)
    doc.getMap('comments').unobserve(onComments)
    doc.awareness.off('update', schedulePresence)
    if (watches.get(target.documentName) === watch) watches.delete(target.documentName)
    for (const wake of [...watch.waiters]) wake()
  }

  watches.set(target.documentName, watch)
  return watch
}

/**
 * Whether an event names the reader itself — same account AND same agent label.
 * One label per agent client is the constraint that makes that identifying;
 * two clients on one account sharing a label would hide each other's writes.
 */
function isOwn(reader: Reader, peer: { uid: number | null, via?: string | null } | null | undefined): boolean {
  if (reader.uid === undefined || reader.uid === null || !peer) return false
  return peer.uid === reader.uid && (peer.via ?? null) === (reader.via ?? null)
}

/**
 * What the log holds from `cursor` on, for one reader.
 *
 * A cursor this log cannot place starts the reader at the head, flagged
 * `restarted`: a watcher is never handed events from before it asked. What the
 * reader itself did is left out — its own presence, writes and messages —
 * because a loop woken by its own echo re-triggers forever. Its own presence
 * goes by account and agent label, not only by client id: an agent that calls
 * again arrives under a new client id and would otherwise report itself.
 * Session events reach every reader whatever it asked for: they end the loop.
 */
export function changesSince(
  watch: SessionWatch,
  cursor: string | undefined,
  kinds: readonly ChangeKind[],
  reader: Reader = {},
): ChangeAnswer {
  const from = seqOf(watch, cursor)
  const missed = from === null ? 0 : Math.min(watch.next - from, watch.events.length)
  const wanted = new Set<string>([...kinds, 'session'])
  const events = (missed <= 0 ? [] : watch.events.slice(-missed))
    .filter(event => wanted.has(event.kind))
    .filter(event => !(event.kind === 'presence' && event.clientId === reader.clientId))
    .filter(event => !(event.kind === 'presence' && isOwn(reader, event.who)))
    .filter(event => !(event.kind === 'blocks' && isOwn(reader, event.by)))
    .filter(event => !(event.kind === 'comments' && isOwn(reader, event.by)))
  return {
    events,
    cursor: cursorAt(watch, watch.next, watch.now()),
    restarted: cursor !== undefined && from === null,
    dropped: from !== null && watch.next - from > watch.events.length,
    editors: watch.humanPeers(),
  }
}

/**
 * Answers as soon as something the watcher asked for happens, or empty-handed
 * at the timeout. A timeout of zero answers from the log and waits for nothing.
 *
 * One request per event, no polling on either side. Whatever landed before the
 * call is already in the log, so a watcher that took time to think never waits
 * for a change it has already missed.
 */
export async function awaitChanges(
  watch: SessionWatch,
  cursor: string | undefined,
  kinds: readonly ChangeKind[],
  timeoutMs: number,
  reader: Reader = {},
  timers: Pick<WatchOptions, 'setTimer' | 'clearTimer'> & { signal?: AbortSignal } = {},
): Promise<ChangeAnswer> {
  // An absent cursor means "from now": pinned here, so the wait resumes from
  // where this call started rather than from wherever the log has got to.
  const from = cursor ?? cursorAt(watch, watch.next, watch.now())
  const first = changesSince(watch, from, kinds, reader)
  // A cursor the log cannot place has nothing to wait for: what it named is
  // gone, so the head is the answer now rather than after the whole timeout.
  if (first.events.length > 0 || first.restarted || watch.closed || timeoutMs <= 0) return first

  const setTimer = timers.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = timers.clearTimer ?? (handle => clearTimeout(handle))
  return new Promise<ChangeAnswer>((resolve) => {
    const done = (): void => {
      clearTimer(deadline)
      watch.waiters.delete(wake)
      timers.signal?.removeEventListener('abort', done)
      resolve(changesSince(watch, from, kinds, reader))
    }
    // Only an event this reader asked for ends the wait; one it filters out
    // leaves it standing rather than answering it with nothing.
    const wake = (): void => {
      if (watch.closed || changesSince(watch, from, kinds, reader).events.length > 0) done()
    }
    const deadline = setTimer(done, timeoutMs)
    ;(deadline as { unref?: () => void }).unref?.()
    watch.waiters.add(wake)
    // Without this a dropped client holds its waiter and timer for the whole
    // timeout.
    timers.signal?.addEventListener('abort', done, { once: true })
  })
}

/** Drops every watch — what a shutdown, and a test, needs. */
export function stopAllWatches(): void {
  for (const watch of [...watches.values()]) watch.stop()
}
