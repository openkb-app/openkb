import { createError } from 'h3'
import * as Y from 'yjs'
import { removeAwarenessStates } from 'y-protocols/awareness'
import { initProseMirrorDoc, updateYFragment } from '@tiptap/y-tiptap'
import { Node as ProseNode } from '@tiptap/pm/model'
import type { JSONContent } from '@tiptap/core'
import type { Hocuspocus } from '@hocuspocus/server'
import { editorSchema } from './editor-schema'
import { parseMarkdownToDoc, parseMarkdownToJson } from '../../app/comark/markdown-engine'
import { mintAuthoredIds } from './agent-block-ids'
import { blockIdOf } from '#shared/page-blocks'
import { actorLabel } from '#shared/utils/attribution'
import { TITLE_KEY, type FieldSpec, type FieldValues } from './entity-fields'
import {
  agentAwarenessUser,
  newClientId,
  presenceCarrier,
  publishAwareness,
  type AwareDoc,
  type PeerIdentity,
} from './agent-awareness'
import { blockSegmentsOfDoc, blockVersion } from './block-versions'
import { mintCommentId, readThreads, recordCommentMessage } from '#shared/block-comments'
import type { AgentPeerState } from '#shared/utils/presence'
import type { ProseMirrorJSON } from './commit'
import type { AttributionPeer } from './collab-attribution'

/**
 * Agent-peer adapter — an agent editing a document the way a browser does.
 *
 * An agent never writes to Drupal directly. It joins the document's live
 * Y.js session as a peer (in-process, via hocuspocus `openDirectConnection`),
 * applies its edits as ordinary CRDT ops, and lets the existing commit service
 * persist them. Three properties fall out of that and are the whole point:
 *
 *   - a human editing the same document sees the agent's changes stream in
 *     live, and can undo/adjust them like any peer's;
 *   - the agent shows up in the presence strip while it works;
 *   - **no external-change banner** — the banner exists to announce writes
 *     that landed in Drupal *behind* the session's back, and an agent edit
 *     never is one.
 *
 * Joining is not authorization. `openDirectConnection` bypasses
 * `onAuthenticate` by construction (there is no handshake), so admission is
 * the session router's job (server/utils/session-router.ts) — and admission is
 * write control, because the Y.Doc is a shared buffer whose content some
 * peer's checkpoint eventually commits. Nothing in this file grants anything.
 */

/** The identity a session peer acts under, as the join gate resolved it. */
export interface AgentActor extends PeerIdentity {
  /** Bearer token — the carrier for every Drupal call in this session. */
  token?: string
}

/** How a session peer reads in a log or a revision message. */
export function agentLabel(actor: AgentActor): string {
  return actorLabel(actor.name, actor.via)
}

/**
 * Transaction origin tag on every op an agent writes.
 *
 * Y.js hands the origin to every observer, so anything downstream — a future
 * provenance sweep, a debug log, an extension deciding whether to react — can
 * tell agent ops from human ones without inspecting content.
 */
export interface AgentOrigin {
  agent: true
  /** "fago via Claude". */
  label: string
  /** Awareness client id this session publishes under. */
  clientId: number
  /**
   * The writer this session enters each touched block's set as (ADR 0002/0003),
   * or null when no account resolves. Carries `via`: the label seats the agent
   * as a member, which is what raises the block's agent review step — agent
   * involvement then survives human rework rather than riding a credential.
   */
  seat: AttributionPeer | null
}

/** Is this transaction origin an agent peer's? */
export function isAgentOrigin(origin: unknown): origin is AgentOrigin {
  return typeof origin === 'object' && origin !== null && (origin as AgentOrigin).agent === true
}

/**
 * The writer a session's ops enter the block sets as — see {@link AgentOrigin.seat}.
 *
 * Seats the resolved account carrying its `via`; that presence in the set is
 * what raises the agent review step (ADR 0002/0003).
 */
function seatOf(actor: AgentActor): AttributionPeer | null {
  return actor.uid > 0 ? { uid: actor.uid, name: actor.name, via: actor.via } : null
}

/**
 * y-protocols evicts awareness states it has not heard from within its
 * outdated-timeout (30s) — browser peers keep themselves alive by re-setting
 * their local state on a timer. An agent has no such loop of its own, so an
 * open session republishes on this interval or the bot silently vanishes from
 * the strip mid-edit.
 */
const PRESENCE_REFRESH_MS = 10_000

/** What a write onto a session that already left the document is told. */
const SESSION_CLOSED = 'The editing session closed before this write reached it. Send it again.'

/**
 * Applies field values to the `fields` Y.Map as whole-key writes.
 *
 * Whole-key, never a partial mutation of a stored object: Y.Map is per-key
 * last-writer-wins (OKB-46), which is what lets an agent and a human edit
 * *different* fields concurrently without conflict and makes a same-field
 * collision converge instead of corrupt. A key whose value already matches is
 * skipped so an agent re-sending unchanged values produces no ops at all.
 *
 * Returns the keys actually written.
 */
export function applyFieldValues(doc: Y.Doc, values: FieldValues): string[] {
  const fields = doc.getMap('fields')
  const written: string[] = []
  for (const [key, value] of Object.entries(values)) {
    if (JSON.stringify(fields.get(key) ?? null) === JSON.stringify(value ?? null)) continue
    fields.set(key, value)
    written.push(key)
  }
  return written
}

/**
 * Applies a markdown body to the document's `default` fragment as a minimal
 * diff against what is already there.
 *
 * The naive write — clear the fragment, insert the new content — would be
 * correct in content and wrong in every other way: every human peer's cursor
 * and selection is a Y.js *relative position* anchored to the item it sits in,
 * so replacing the items moves everyone's caret to the top and turns a
 * one-word agent fix into a whole-document change for the CRDT to merge.
 * `updateYFragment` (y-prosemirror's own reconciler, the one the browser
 * binding uses) walks the existing Y types against the new ProseMirror tree
 * and touches only what differs, so untouched blocks keep their identity and
 * the peers anchored in them keep their positions.
 *
 * The markdown goes through the same parser and schema the browser editor and
 * the commit serializer use, so an agent cannot express anything a human
 * could not have typed.
 *
 * `authored` says whether this write is authorship. It is, for an agent's own
 * edit: the blocks it created are minted stable ids, exactly as a browser
 * peer's minter would (server/utils/agent-block-ids.ts). It is not for a
 * restoration of content that already exists in Drupal — no ids are stamped,
 * and the document serializes back to the same bytes. Who wrote what is
 * settled elsewhere either way: Drupal's presave attributes the write it
 * stores.
 */
export function applyBodyMarkdown(
  doc: Y.Doc,
  markdown: string,
  authored = false,
): void {
  const fragment = doc.getXmlFragment('default')
  const { doc: before, meta } = initProseMirrorDoc(fragment, editorSchema)
  if (!authored) {
    updateYFragment(doc, fragment, parseMarkdownToDoc(markdown), meta)
    return
  }
  const { json } = mintAuthoredIds(before, parseMarkdownToJson(markdown))
  updateYFragment(doc, fragment, ProseNode.fromJSON(editorSchema, json), meta)
}

/**
 * The replacement content, with its first block wearing the id it replaces.
 *
 * A rewritten block is the same block: the sidecar keys its contributors and
 * its review history on that id, and minting a fresh one would silently
 * discard both and read as a delete plus an insert. Anything the replacement
 * adds beyond the first block is new and is minted for like any other authored
 * content.
 */
function keepId(replacement: JSONContent[], id: string): JSONContent[] {
  const [first, ...rest] = replacement
  if (!first) return replacement
  return [{ ...first, attrs: { ...(first.attrs ?? {}), id } }, ...rest]
}

/**
 * Applies block-level writes, leaving every block they do not name alone.
 *
 * Built on the same reconciler as {@link applyBodyMarkdown}: the ops are
 * resolved into a new top-level sequence and `updateYFragment` walks it against
 * what is there. So an unnamed block is not "restored to its old value" — it is
 * never written at all, its Y items keep their identity, and a peer with a
 * cursor in it keeps their position.
 *
 * Ops are applied in order against the sequence as the earlier ones left it,
 * so inserting after a block and then replacing it both refer to the block the
 * caller meant. An op naming no block lands after the last block the op before
 * it wrote — how a caller adds several new blocks in a row, none of which has
 * an id until this function mints one.
 *
 * A document with no blocks holds nothing an op could name, so its first op
 * needs no anchor and appends — the page a human created empty is filled the
 * same way as any other.
 *
 * @returns
 *   Every block the ops wrote → the version it holds now, read off the written
 *   document by the one canonical helper (./block-versions). A replacement is
 *   keyed by the id it kept; an insertion by the id minted for it here, which
 *   is the caller's only way to learn it. Both are what the next op on that
 *   block sends as `expect`, so editing what you just wrote needs no read.
 *
 * @throws {UnknownBlockError}
 *   When an op names a block the document does not hold. Nothing is written —
 *   a half-applied set of block edits is worse than a refused one.
 * @throws {UnchainedBlockError}
 *   When an anchorless op follows one whose markdown wrote nothing.
 * @throws {UnanchoredBlockError}
 *   When the first op names no block and the document holds some.
 */
export function applyBlockOps(
  doc: Y.Doc,
  ops: BlockOp[],
  authored = false,
): Record<string, string> {
  const fragment = doc.getXmlFragment('default')
  const { doc: before, meta } = initProseMirrorDoc(fragment, editorSchema)
  const json = before.toJSON() as JSONContent
  let content = [...(json.content ?? [])]

  // The nodes the ops put into the sequence, by reference. An inserted block
  // has no id until the mint below, so its id is read back out of the minted
  // tree at the position the reference stands at.
  const placed: JSONContent[] = []
  // What an anchorless op follows: the last node the op before it put in.
  let chained: JSONContent | undefined

  ops.forEach((op, index) => {
    const anchor = blockOpAnchor(op)
    // A document with no blocks holds nothing to name, so its first op needs
    // no anchor and appends. A broken chain stays a refusal even once the ops
    // have emptied the document: the caller meant to follow a block.
    const appends = anchor === null && !chained
    if (appends) {
      if (index > 0) throw new UnchainedBlockError(index)
      if (content.length > 0) throw new UnanchoredBlockError(index)
    }
    const at = appends
      ? -1
      : anchor === null
        ? content.indexOf(chained!)
        : content.findIndex(node => blockIdOf(node) === anchor)
    if (!appends && at === -1) throw new UnknownBlockError(anchor!)

    const parsed = parseMarkdownToJson(op.markdown).content ?? []
    const replacement = 'id' in op ? keepId(parsed, op.id) : parsed
    // An anchorless op lands where `after` would, on the block it chains from.
    const insertAt = 'before' in op ? at : at + 1
    content = 'id' in op
      ? [...content.slice(0, at), ...replacement, ...content.slice(at + 1)]
      : [...content.slice(0, insertAt), ...replacement, ...content.slice(insertAt)]

    placed.push(...replacement)
    chained = replacement.at(-1)
  })

  const next = { ...json, content }
  const minted = authored ? mintAuthoredIds(before, next).json : next
  const written = ProseNode.fromJSON(editorSchema, minted)
  updateYFragment(doc, fragment, written, meta)

  // Versions off the node just written, not off a re-read: it is the tree the
  // fragment now holds, and segmenting it is the same derivation the read side
  // and refuseStaleBlocks run.
  const segments = blockSegmentsOfDoc(written.toJSON() as ProseMirrorJSON)
  // The mint maps the top level one-to-one, so a node's position carries over.
  const mintedContent = minted.content ?? []
  const position = new Map(content.map((node, index) => [node, index]))

  const versions: Record<string, string> = {}
  for (const node of placed) {
    const index = position.get(node)
    // A block a later op replaced is no longer there; that op reports what
    // stands in its place.
    if (index === undefined) continue
    const id = blockIdOf(mintedContent[index] ?? {})
    const markdown = id === null ? undefined : segments.get(id)
    // A block the body exposes no version for is one no op can `expect` — the
    // map answers only what a retry can use.
    if (id !== null && markdown !== undefined) versions[id] = blockVersion(markdown)
  }
  return versions
}

/**
 * One block-level write, naming the block it acts on.
 *
 * The agent's editing granularity, and the reason it has one: a whole-document
 * write says "the page is now this", which is a claim about every block in
 * it — including the ones a human is editing in the same session and the ones
 * a reviewer already signed off. A block op says only what it means.
 *
 * `expect` is the block's version as the caller last read it — see
 * {@link refuseStaleBlocks}.
 */
export type BlockOp = { expect?: string } & (
  /** Replace the block carrying this id with `markdown`. */
  | { id: string, markdown: string }
  /** Insert `markdown` immediately after the block carrying this id. */
  | { after: string, markdown: string }
  /** Insert `markdown` immediately before the block carrying this id. */
  | { before: string, markdown: string }
  /**
   * Insert `markdown` after whatever the op before it put in — how a caller
   * writes several new blocks in a row without knowing the id of a block it
   * has not created yet. As the first op, it fills a document that holds no
   * blocks.
   */
  | { markdown: string }
)

/** An untrusted value read as a block-op list, or the fault disqualifying it. */
export type BlockOpList = { ops: BlockOp[] } | { fault: string }

/**
 * Reads an untrusted value as a list of block ops.
 *
 * A fault names the op it is about by index. A caller sending five ops learns
 * nothing from "the list is malformed" — it has to bisect its own request to
 * find out which one the server would not take.
 */
export function readBlockOpList(value: unknown): BlockOpList {
  if (!Array.isArray(value)) return { fault: '"blocks" must be a list of block ops.' }

  for (const [index, op] of value.entries()) {
    const at = `blocks[${index}]`
    if (!op || typeof op !== 'object') return { fault: `${at} must be an object.` }

    const fields = op as Record<string, unknown>
    if (typeof fields.markdown !== 'string') return { fault: `${at} needs a "markdown" string.` }
    if (!['undefined', 'string'].includes(typeof fields.expect)) {
      return { fault: `${at}.expect must be a version string.` }
    }

    const anchors = ['id', 'after', 'before'].filter(key => typeof fields[key] === 'string')
    if (anchors.length > 1) {
      return { fault: `${at} names ${anchors.join(' and ')} — an op has one anchor.` }
    }
    // Whether an anchorless first op is allowed depends on the document, so
    // that refusal is applyBlockOps'.
    if (anchors.length === 0 && fields.expect !== undefined) {
      return {
        fault: index === 0
          ? `${at} names no block to expect a version for.`
          : `${at} chains after blocks[${index - 1}], so it names no block to expect a version for.`,
      }
    }
  }

  return { ops: value as BlockOp[] }
}

/** The block id an op is anchored to, or null when it chains after the last one. */
export function blockOpAnchor(op: BlockOp): string | null {
  if ('id' in op) return op.id
  if ('after' in op) return op.after
  if ('before' in op) return op.before
  return null
}

/** Raised when a block op names a block the document does not hold. */
export class UnknownBlockError extends Error {
  constructor(public readonly blockId: string) {
    super(`No block "${blockId}" in this page.`)
  }
}

/** Raised when the first op names no block and the document holds some. */
export class UnanchoredBlockError extends Error {
  constructor(public readonly index: number) {
    super(`blocks[${index}] needs one of id / after / before — no op precedes it to chain after.`)
    this.name = 'UnanchoredBlockError'
  }
}

/** Raised when an anchorless op chains after an op that wrote no block. */
export class UnchainedBlockError extends Error {
  constructor(public readonly index: number) {
    super(`blocks[${index}] chains after blocks[${index - 1}], which wrote no block to follow.`)
    this.name = 'UnchainedBlockError'
  }
}

/** One op refused because the block moved under it. */
export interface BlockConflict {
  /** Which op was refused, by its index in the request's list. */
  index: number
  /** The block it named. */
  id: string
  /** The version the op expected. */
  expected: string
  /** What the block holds now — send this back as `expect` to retry. */
  version: string
  /** The block's current canonical markdown, to re-apply the edit against. */
  markdown: string
}

/** Raised when at least one op expected a version the block no longer holds. */
export class StaleBlockError extends Error {
  constructor(public readonly conflicts: BlockConflict[]) {
    super(
      `${conflicts.length} block(s) changed since you read them — nothing was `
      + 'written. Re-apply each refused op to the markdown reported for it and '
      + 'send the reported version as "expect".',
    )
    this.name = 'StaleBlockError'
  }
}

/**
 * Refuses the whole call when any op expects a version its block no longer
 * holds — compare-and-swap over block content.
 *
 * Runs inside the document's transaction, against the document as it stands at
 * that moment. Nothing can move between the check and the write: a Y.Doc has
 * one writer at a time in this process, and the caller holds it for both.
 *
 * All-or-nothing, like {@link applyBlockOps}: a half-applied set of block edits
 * is worse than a refused one. Which ops were stale is still reported per
 * index, each carrying the block's current markdown and version, so the retry
 * needs no second read.
 *
 * An op with no `expect` is not checked — the field is optional for wire
 * compatibility.
 *
 * @throws {StaleBlockError}
 * @throws {UnknownBlockError}
 *   When an op with an `expect` names a block that carries no version. Such a
 *   block is not one the page exposes — `getPageForEditing`'s `versions`
 *   map is the
 *   index an op addresses through — so nothing the caller read can match, and
 *   passing it through would be a write nobody checked.
 */
export function refuseStaleBlocks(doc: Y.Doc, ops: BlockOp[]): void {
  if (!ops.some(op => op.expect)) return
  const { doc: current } = initProseMirrorDoc(doc.getXmlFragment('default'), editorSchema)
  const segments = blockSegmentsOfDoc(current.toJSON() as ProseMirrorJSON)

  const conflicts: BlockConflict[] = []
  ops.forEach((op, index) => {
    const expected = op.expect
    if (!expected) return
    const id = blockOpAnchor(op)
    // An anchorless op carries no `expect` — readBlockOpList refuses one.
    if (id === null) return
    const markdown = segments.get(id)
    if (markdown === undefined) throw new UnknownBlockError(id)
    const version = blockVersion(markdown)
    if (version !== expected) conflicts.push({ index, id, expected, version, markdown })
  })

  if (conflicts.length > 0) throw new StaleBlockError(conflicts)
}

/**
 * One message an agent says about a block: a reply when it names a thread, a
 * new block-level thread when it does not.
 *
 * A conversation is not content — it rides the document's own `comments` map
 * (ADR 0006) — but it is written through the same session for the same reason
 * an edit is: the human with the page open sees it arrive, and the next
 * checkpoint files it beside the page.
 */
export interface CommentOp {
  blockId: string
  /** The thread to reply into; absent opens one on the block. */
  threadId?: string
  text: string
}

/**
 * Writes one message into a block's conversation, under the actor's identity.
 *
 * The block and, when named, the thread must exist: the map's coherence sweep
 * drops a message at a coordinate nobody can reach, so it is refused rather
 * than accepted and lost. Resolving is not offered here — an agent may say
 * something about a thread, not decide it is done.
 *
 * @throws {UnknownBlockError}
 * @throws {UnknownThreadError}
 */
export function applyComment(doc: Y.Doc, actor: AgentActor, op: CommentOp): { threadId: string, msgId: string } {
  const { doc: current } = initProseMirrorDoc(doc.getXmlFragment('default'), editorSchema)
  if (!blockSegmentsOfDoc(current.toJSON() as ProseMirrorJSON).has(op.blockId)) {
    throw new UnknownBlockError(op.blockId)
  }
  if (op.threadId !== undefined && !readThreads(doc)
    .some(thread => thread.blockId === op.blockId && thread.threadId === op.threadId)) {
    throw new UnknownThreadError(op.blockId, op.threadId)
  }

  const threadId = op.threadId ?? mintCommentId('c')
  const msgId = mintCommentId('m')
  recordCommentMessage(doc, op.blockId, threadId, msgId, {
    uid: actor.uid,
    name: actor.name,
    via: actor.via,
    at: Date.now(),
    text: op.text,
  })
  return { threadId, msgId }
}

/** Raised when a comment names a thread the block does not carry. */
export class UnknownThreadError extends Error {
  constructor(public readonly blockId: string, public readonly threadId: string) {
    super(`No thread "${threadId}" on block "${blockId}".`)
    this.name = 'UnknownThreadError'
  }
}

/** What an agent asks a session to apply. Every lane is optional. */
export interface AgentOps {
  /** Frontmatter keys (plus `title`) → new values. */
  fields?: FieldValues
  /** Replacement body, as comark markdown. */
  body?: string
  /** Block-level writes, applied in order. */
  blocks?: BlockOp[]
  /** One message on a block's conversation. */
  comment?: CommentOp
}

/** What an agent session did. */
export interface AgentOpsResult {
  /** Field keys whose value the session actually changed. */
  fields: string[]
  /** Whether a body was applied (it may still have been a no-op diff). */
  body: boolean
  /**
   * Every block the ops wrote → the version it holds after the write, an
   * insertion under the id minted for it. Send one straight back as the next
   * op's `expect`.
   */
  blocks: Record<string, string>
  /** The thread the message landed in, and the message's own id. */
  comment?: { threadId: string, msgId: string }
}

/**
 * Validates ops against the exposure contract before a single one is written.
 *
 * The contract (`GET /openkb/schema`) is the only addressable surface: a key
 * it does not carry cannot be mapped to a Drupal field, so accepting it would
 * mean guessing `field_<key>` — writing the wrong field, or silently dropping
 * the value at commit time. Cardinality is checked here too, because a scalar
 * where an array belongs survives in the Y.Map and only fails much later, at
 * the PATCH, with a message pointing at the wrong actor.
 *
 * Returns per-key messages, keyed as the commit pipeline keys them, or an
 * empty object when the ops are addressable.
 */
export function validateFieldOps(specs: FieldSpec[], values: FieldValues): Record<string, string[]> {
  const specByKey = new Map(specs.map(spec => [spec.key, spec]))
  const errors: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(values)) {
    if (key === TITLE_KEY) {
      if (typeof value !== 'string') {
        (errors[key] ??= []).push('The title must be a string.')
      }
      continue
    }
    const spec = specByKey.get(key)
    if (!spec) {
      (errors[key] ??= []).push(`No exposed field for frontmatter key "${key}".`)
      continue
    }
    if (spec.multiple && value !== null && !Array.isArray(value)) {
      (errors[key] ??= []).push(`"${key}" is a multi-value field and takes an array.`)
    }
    if (!spec.multiple && Array.isArray(value)) {
      (errors[key] ??= []).push(`"${key}" is a single-value field and takes one value.`)
    }
  }
  return errors
}

/** Hocuspocus surface an agent session needs — narrowed for testability. */
export type AgentPeerHost = Pick<Hocuspocus, 'openDirectConnection' | 'documents'>

/**
 * An open agent session: the peer is in the room until {@link leave}.
 *
 * It stays there between tool calls — the registry in
 * server/utils/agent-sessions.ts owns how long, and calls {@link leave}.
 */
export interface AgentSession {
  /** `node:<nid>`. */
  documentName: string
  /** Whether the room was already live, or this session started it headless. */
  entry: 'joined' | 'started'
  /** Live document, for callers that need to read state back. */
  doc: AwareDoc
  /** Awareness client id the bot presence is published under. */
  clientId: number
  /** The identity its writes and messages carry. */
  actor: AgentActor
  /** Browser peers currently connected (the agent itself is not one). */
  humanPeers: () => number
  /** Apply ops in one tagged transaction; a 409 once the session has left. */
  apply: (ops: AgentOps) => AgentOpsResult
  /** Withdraw presence and close the direct connection. */
  leave: () => Promise<void>
}

/**
 * Browser peers attached to a document.
 *
 * Websocket connections only: `getConnectionsCount()` would also count direct
 * connections — an agent session's own included — and every caller needs "is a
 * human watching", not "is anyone attached".
 */
export function humanPeersOf(doc: AwareDoc | undefined): number {
  return (doc as (AwareDoc & { getConnections?: () => unknown[] }) | undefined)
    ?.getConnections?.().length ?? 0
}

export interface OpenAgentSessionOptions {
  /** Awareness refresh cadence; tests pass a stub to avoid real timers. */
  refreshMs?: number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  clearTimer?: (handle: ReturnType<typeof setInterval>) => void
  /** Injectable clock for the provenance record. */
  now?: () => number
}

/**
 * Joins (or headlessly starts) a document's session as `actor`.
 *
 * `openDirectConnection` reuses the loaded document when one is live and
 * otherwise creates it — which runs the plugin's `onLoadDocument`, so a
 * headless start seeds from Drupal exactly like a human's first connect. The
 * two cases differ only in what we report; nothing downstream branches on it.
 */
export async function openAgentSession(
  host: AgentPeerHost,
  nid: number,
  actor: AgentActor,
  options: OpenAgentSessionOptions = {},
): Promise<AgentSession> {
  const documentName = `node:${nid}`
  const entry = host.documents.has(documentName) ? 'joined' : 'started'
  const user = agentAwarenessUser(actor)
  const label = agentLabel(actor)

  const connection = await host.openDirectConnection(documentName, { user })
  const document = connection.document as unknown as AwareDoc
  const clientId = newClientId()
  const origin: AgentOrigin = { agent: true, label, clientId, seat: seatOf(actor) }

  const carrier = presenceCarrier(clientId)
  // Mutable so the refresh timer republishes the CURRENT state: a closure over
  // the initial one would wipe the claim on the next tick.
  let state: AgentPeerState = { user }
  const publish = () => publishAwareness(document, carrier, clientId, state, origin)
  publish()
  const setTimer = options.setTimer ?? ((fn, ms) => setInterval(fn, ms))
  const clearTimer = options.clearTimer ?? (handle => clearInterval(handle))
  const refresh = setTimer(publish, options.refreshMs ?? PRESENCE_REFRESH_MS)

  let left = false

  const humanPeers = () => humanPeersOf(connection.document as unknown as AwareDoc)

  return {
    documentName,
    entry,
    doc: document,
    clientId,
    actor,
    humanPeers,

    // One transaction for both lanes, tagged with {@link AgentOrigin}. Not
    // `connection.transact`: that wraps the callback in a transaction of its
    // own tagged `{ source: 'local' }`, and a nested transaction keeps the
    // OUTER origin — the agent tag would never reach an observer. Transacting
    // on the document directly is the same write (a hocuspocus Document is a
    // Y.Doc; its update handler broadcasts to peers and fires `onChange`
    // either way) with the origin we need.
    apply(ops: AgentOps): AgentOpsResult {
      // A session that left is detached from the document: its ops would reach
      // nothing while the caller is told the write landed.
      if (left) throw createError({ statusCode: 409, statusMessage: SESSION_CLOSED })
      const result: AgentOpsResult = { fields: [], body: false, blocks: {} }
      Y.transact(document, () => {
        // Before anything in this transaction is written: a stale write must
        // leave the document exactly as it found it, fields included.
        if (ops.blocks?.length) refuseStaleBlocks(document, ops.blocks)
        if (ops.fields) result.fields = applyFieldValues(document, ops.fields)
        if (ops.body !== undefined) {
          applyBodyMarkdown(document, ops.body, true)
          result.body = true
        }
        if (ops.blocks?.length) {
          result.blocks = applyBlockOps(document, ops.blocks, true)
        }
        if (ops.comment) result.comment = applyComment(document, actor, ops.comment)
      }, origin)
      // The blocks this write touched, republished as part of the peer's own
      // state: "somebody is working here", for as long as the session is. A
      // write that named no block says nothing, and clears what the previous
      // one said.
      const claimed = Object.keys(result.blocks)
      state = claimed.length > 0 ? { user, claim: { blocks: claimed } } : { user }
      publish()
      return result
    },

    async leave(): Promise<void> {
      if (left) return
      left = true
      clearTimer(refresh)
      // Withdraw presence before the connection goes: peers see the bot leave
      // rather than a state that lingers until the outdated-timeout.
      removeAwarenessStates(document.awareness, [clientId], origin)
      carrier.destroy()
      await connection.disconnect()
    },
  }
}
