import type { Node as PMNode } from '@tiptap/pm/model'
import { blockIdOf, holdsNothing, ID_BEARING_TYPES, REVIEW_STEPS, type ReviewStep, TITLE_REVIEW_KEY } from '#shared/page-blocks'
import type { CoAuthor } from './commit'

/**
 * Who wrote which block in a live session — witnessed by this server (ADR 0002).
 *
 * Every update arrives on a websocket authenticated against Drupal, so the
 * connection knows whose keystrokes it carries; no client says. A pass at each
 * writer boundary diffs content prints and adds the writer to each changed
 * block's set. The set is monotone within a block's open episode: re-adding a
 * writer is a no-op, agents are members like anyone else and carry their `via`
 * label, and the human who reworks an agent's block is added while the agent
 * stays — so the agent step holds through the rework.
 *
 * A checkpoint states the whole set per changed block, and Drupal unions it in
 * (idempotent) and seeds four-eyes from it. Per-uid character totals live on
 * this ledger only, to elect the acting account for a checkpoint nobody
 * triggered; they are never persisted, stated or stored.
 * Blocks whose bytes are back to what Drupal stores open no episode.
 */

/** A peer of one document. */
export interface AttributionPeer {
  uid: number
  name?: string
  /** Agent client's label. Non-null marks an agent writer ("fago via Claude"). */
  via?: string | null
}

/** The account and agent-label a block's writer set is keyed on. */
export interface WriterRef {
  uid: number
  via: string | null
}

/** Stable identity of a writer — union membership is by this key. */
export function writerKey(w: { uid: number, via?: string | null }): string {
  return JSON.stringify([w.uid, w.via ?? null])
}

/** One block a writer touched, and by how much (feeds the author election). */
export interface BlockTouch {
  id: string
  chars: number
}

/**
 * What one block held at a pass. `print` is whether it moved (its whole
 * content, so a same-length rewrite counts); `chars` feeds the election; `index`
 * answers which occurrence of a shared id this is — see {@link blockPrints}.
 */
export interface BlockPrint {
  chars: number
  print: string
  index: number
  /** Whether the block holds nothing Drupal would store ({@link holdsNothing}). */
  empty: boolean
}

/** A block's monotone writer set within its open episode. */
export interface BlockWriters {
  /** writerKey => writer. */
  writers: Map<string, WriterRef>
}

/**
 * One peer's sign-off, as the server recorded it.
 *
 * Never read out of the document: a Y.Doc is a shared buffer every peer may
 * write, and awareness is client-declared, so the only identity worth carrying
 * is the one the connection authenticated with (ADR 0001/0004). Drupal applies
 * the review rules to it; this side only says who signed off what.
 */
export interface ReviewAction {
  /** The review item signed off — a block id, or a key the document has no node for. */
  item: string
  /** The review step signed off. */
  step: ReviewStep
  /** The account the connection belongs to. */
  uid: number
  /** The item's print at the sign-off, `null` for one the document holds no
   *  block for. A block edited since is a different block. */
  print: string | null
}

/**
 * One stateless message read as a sign-off this server will carry, or null.
 *
 * The uid is the connection's and nothing else: the message says what was
 * written, never who wrote it. A seat with no authenticated account — an
 * agent's in-process connection — therefore signs nothing off, which is the
 * whole point of the agent step (ADR 0003).
 *
 * @param payload The raw stateless message.
 * @param uid The account the connection authenticated as.
 * @param printOf The document's current print for a review item: a string for
 *   a block it holds, `null` for a review item it holds no block for — a
 *   removed block or the title — and `undefined` for a key that is neither,
 *   which is not carried.
 */
export function reviewActionFrom(
  payload: string,
  uid: number,
  printOf: (item: string) => string | null | undefined,
): ReviewAction | null {
  let message: { type?: unknown, item?: unknown, step?: unknown }
  try {
    message = JSON.parse(payload)
  }
  catch {
    return null
  }
  if (message?.type !== 'review.approve') return null
  const item = typeof message.item === 'string' ? message.item : ''
  const step = message.step as ReviewStep
  if (uid <= 0 || item === '' || !REVIEW_STEPS.includes(step)) return null
  const print = printOf(item)
  return print === undefined ? null : { item, step, uid, print }
}

/** One document's accounting. */
export interface Ledger {
  /** Each block as of the last pass. Meaningless until hydrated. */
  baseline: Map<string, BlockPrint>
  /**
   * Whether {@link baseline} describes content this server has seen. False
   * until {@link hydrateLedger} runs: an unhydrated ledger reads the whole
   * document as growth, so it must credit nobody rather than the first peer.
   */
  hydrated: boolean
  /** Open episodes: block id => the writers who changed it since Drupal's copy. */
  sets: Map<string, BlockWriters>
  /** Each block's print as Drupal last stored it. A block back to this opens no episode. */
  committed: Map<string, string>
  /**
   * Who the document's pending field changes belong to, by {@link writerKey}.
   *
   * The block pass measures text and cannot see a field edit, so this is the
   * fields lane's own accounting. Membership only, for the whole lane rather
   * than per key: the revision log names writers, and a checkpoint writes every
   * dirty field at once. Cleared once the lane matches Drupal again.
   */
  fieldWriters: Map<string, WriterRef>
  /** The peers that authenticated for this document. */
  peers: Map<number, AttributionPeer>
  /** uid => characters this session, for electing the acting account. */
  totals: Map<number, number>
  /** Whose edits the next pass credits. */
  writer: WriterRef | null
  /** Sign-offs waiting for the checkpoint that carries them to Drupal. */
  actions: ReviewAction[]
}

export function newLedger(): Ledger {
  return {
    baseline: new Map(),
    hydrated: false,
    sets: new Map(),
    committed: new Map(),
    fieldWriters: new Map(),
    peers: new Map(),
    totals: new Map(),
    writer: null,
    actions: [],
  }
}

/**
 * Every id-bearing top-level block as this pass finds it, keyed by block id.
 *
 * Blocks without an id are skipped — nothing can flag, approve or credit what
 * it cannot name. A component fence is measured over its whole subtree. The
 * print is the block's ProseMirror JSON, exactly what the commit serializes
 * from, so every edit Drupal's byte diff will see moves this print first.
 *
 * ## Two blocks wearing one id
 *
 * A modified client can hand in two top-level blocks under one id. An id names
 * one block — its set, comments and sign-offs are all keyed on it — so only one
 * occurrence keeps it. `prior` (the last pass's print for that id, chained back
 * to the block Drupal stores) names the incumbent; the rest are re-minted by
 * the commit (see {@link sharedIdKeepers}). Where no occurrence holds the prior
 * print, or several do, document order decides. A byte-identical decoy placed
 * first therefore takes the id, and the real block is re-minted back into
 * review — accepted, not prevented: the text under the id is still what was
 * signed off, its set still credits its writers, and any later edit reopens
 * four-eyes, so nothing unreviewed publishes.
 */
export function blockPrints(doc: PMNode, prior?: ReadonlyMap<string, BlockPrint>): Map<string, BlockPrint> {
  const wearers = new Map<string, BlockPrint[]>()
  doc.forEach((node) => {
    const id = blockIdOf(node)
    if (id === null || !ID_BEARING_TYPES.has(node.type.name)) return
    const worn = wearers.get(id)
    const print: BlockPrint = {
      chars: node.textContent.length,
      print: JSON.stringify(node.toJSON()),
      index: worn?.length ?? 0,
      empty: holdsNothing(node),
    }
    if (worn) worn.push(print)
    else wearers.set(id, [print])
  })

  const prints = new Map<string, BlockPrint>()
  for (const [id, worn] of wearers) prints.set(id, incumbent(worn, prior?.get(id)?.print))
  return prints
}

/** Which of the blocks wearing one id this index describes. */
function incumbent(worn: BlockPrint[], held: string | undefined): BlockPrint {
  if (worn.length === 1 || held === undefined) return worn[0]!
  const holders = worn.filter(print => print.print === held)
  return holders.length === 1 ? holders[0]! : worn[0]!
}

/**
 * The occurrence that keeps each shared id — the commit's instruction, as
 * `id` => index in document order. Handed over rather than re-derived so the
 * two ends of the seam cannot disagree; exact because the checkpoint pass is
 * synchronous and `commitDocument` serializes before its first await.
 */
export function sharedIdKeepers(baseline: ReadonlyMap<string, BlockPrint>): Map<string, number> {
  const keepers = new Map<string, number>()
  for (const [id, print] of baseline) {
    if (print.index !== 0) keepers.set(id, print.index)
  }
  return keepers
}

/**
 * Blocks whose print moved between two passes, with their growth.
 *
 * A block the pass no longer finds moved too: taking a block out is a change
 * to what the page says, and the only trace of it is its absence, so it is
 * named here or by nothing. It grew by nothing, so it elects no author.
 */
export function diffTouched(baseline: Map<string, BlockPrint>, current: Map<string, BlockPrint>): BlockTouch[] {
  const out: BlockTouch[] = []
  for (const [id, now] of current) {
    const before = baseline.get(id)
    if (before?.print === now.print) continue
    out.push({ id, chars: Math.max(0, now.chars - (before?.chars ?? 0)) })
  }
  for (const id of baseline.keys()) {
    if (!current.has(id)) out.push({ id, chars: 0 })
  }
  return out
}

/**
 * Takes the document as the ledger's starting point, crediting nobody for it.
 *
 * Run once the content is genuinely in hand (fragment loaded, or the first
 * peer's hydration applied) — against a merely-empty document it would baseline
 * at zero and hand the hydration that follows to whoever sent it. It is also
 * this session's first answer to what Drupal holds: nothing is written yet, so
 * the opening content is it.
 */
export function hydrateLedger(ledger: Ledger, doc: PMNode): void {
  ledger.baseline = blockPrints(doc)
  ledger.committed = new Map([...ledger.baseline].map(([id, { print }]) => [id, print]))
  ledger.hydrated = true
}

/**
 * The durable half of the ledger, as it rides inside the document (ADR 0005).
 *
 * Persisted with the document's own snapshot, so a restart restores the open
 * episodes and what Drupal last stored — an undelivered window survives and
 * is stated by the next session's first checkpoint, still naming the
 * original writers. Baseline, peers, totals and writer are per-process
 * decoration and are rebuilt live.
 */
export interface LedgerSnapshot {
  sets: Record<string, WriterRef[]>
  committed: Record<string, string>
  /** Pending field changes' writers — the fields lane's undelivered window. */
  fieldWriters?: WriterRef[]
}

/** The durable half of the ledger, for persisting beside the document. */
export function ledgerSnapshot(ledger: Ledger): LedgerSnapshot {
  const sets: Record<string, WriterRef[]> = {}
  for (const [id, set] of ledger.sets) {
    sets[id] = [...set.writers.values()].map(w => ({ uid: w.uid, via: w.via }))
  }
  return {
    sets,
    committed: Object.fromEntries(ledger.committed),
    fieldWriters: [...ledger.fieldWriters.values()].map(w => ({ uid: w.uid, via: w.via })),
  }
}

/**
 * Restores the durable half into a fresh ledger, against the loaded document.
 *
 * `committed` is what Drupal held; the document may legitimately be ahead of
 * it — that difference IS the undelivered window. A persisted set whose block
 * exists neither in the document nor in Drupal's record is corruption and is
 * dropped to unwitnessed (ADR 0004): a window can only state blocks the
 * document still shows.
 */
export function adoptSnapshot(ledger: Ledger, doc: PMNode, snap: LedgerSnapshot): void {
  ledger.baseline = blockPrints(doc)
  ledger.committed = new Map(Object.entries(snap.committed))
  ledger.sets = new Map()
  for (const [id, writers] of Object.entries(snap.sets)) {
    if (!ledger.baseline.has(id) && !(id in snap.committed)) continue
    const set: BlockWriters = { writers: new Map() }
    for (const w of writers) {
      if (typeof w?.uid === 'number' && w.uid > 0) set.writers.set(writerKey(w), { uid: w.uid, via: w.via ?? null })
    }
    if (set.writers.size > 0) ledger.sets.set(id, set)
  }
  ledger.fieldWriters = new Map()
  for (const w of snap.fieldWriters ?? []) {
    if (typeof w?.uid === 'number' && w.uid > 0) {
      ledger.fieldWriters.set(writerKey(w), { uid: w.uid, via: w.via ?? null })
    }
  }
  ledger.hydrated = true
}

/**
 * Adds the ledger's current writer to each block it changed since the last
 * pass, and returns those touches for the caller.
 *
 * Credits nobody, only advancing the baseline, when the ledger is unhydrated,
 * has no writer, or nothing moved. Union semantics make the add idempotent: a
 * writer already in a block's set is unchanged, so a block reworked by several
 * passes of one peer accrues them once. Agents are seated like anyone else and
 * enter with their `via` (ADR 0003).
 */
export function creditWriter(ledger: Ledger, doc: PMNode): { peer: AttributionPeer | null, touches: BlockTouch[] } {
  const current = blockPrints(doc, ledger.baseline)
  const touches = ledger.hydrated ? diffTouched(ledger.baseline, current) : []
  ledger.baseline = current

  const writer = ledger.writer
  const peer = writer === null ? null : ledger.peers.get(writer.uid) ?? null
  if (!peer || writer === null || touches.length === 0) return { peer: null, touches: [] }

  const key = writerKey(writer)
  const ref: WriterRef = { uid: writer.uid, via: writer.via }
  for (const { id, chars } of touches) {
    const set = ledger.sets.get(id) ?? { writers: new Map() }
    set.writers.set(key, ref)
    ledger.sets.set(id, set)
    ledger.totals.set(writer.uid, (ledger.totals.get(writer.uid) ?? 0) + chars)
  }
  return { peer: { uid: peer.uid, name: peer.name, via: writer.via }, touches }
}

/**
 * The account an incoming update is written by, or null for one carrying no
 * identity (a server `_meta` write, or a seat-less agent write).
 *
 * A client update carries `{ source: 'connection', connection }`, whose context
 * is what onAuthenticate returned — Drupal-derived, never client-declared. An
 * agent seat rides the transaction tag (`AgentOrigin.seat`), carrying the
 * account and its `via`. Anything unrecognised is nobody: guessing is how a
 * write ends up credited to whoever typed last.
 */
export function writerOfOrigin(origin: unknown): WriterRef | null {
  const tagged = origin as {
    source?: string
    connection?: { context?: unknown }
    context?: unknown
    agent?: boolean
    seat?: AttributionPeer | null
  } | null
  if (tagged?.agent === true) {
    const seat = tagged.seat
    return seat && Number.isFinite(seat.uid) && seat.uid > 0
      ? { uid: seat.uid, via: seat.via ?? null }
      : null
  }
  const ctx = (tagged?.source === 'connection' ? tagged.connection?.context : tagged?.context) as
    { user?: { uid?: number } } | undefined
  const uid = Number(ctx?.user?.uid)
  return Number.isFinite(uid) && uid > 0 ? { uid, via: null } : null
}

/**
 * Whether a transaction is somebody writing, as opposed to this server keeping
 * its own books. Hocuspocus tags a peer's or direct connection's transaction;
 * the server's own `_meta` writes carry no origin. Only the first is a writer
 * boundary — treating a `_meta` write as one would reset the writer to nobody.
 */
export function isPeerUpdate(origin: unknown): boolean {
  const source = (origin as { source?: unknown } | null)?.source
  return source === 'connection' || source === 'local' || source === 'redis'
}

/**
 * Everything a checkpoint states about its window (ADR 0002): the writer set
 * per changed block, and the human the revision is filed under.
 *
 * Only blocks whose bytes differ from Drupal's copy are stated — text typed and
 * taken back opens no episode. The set is exhaustive for those: a block Drupal
 * calls changed that no set names is writing this server never witnessed, and
 * Drupal stamps it an empty set — approvable by an admin only, healed by an
 * identified edit. The per-block statement is membership only — `{uid, via}`,
 * no amounts (ADR 0002). The character totals that elect the author live
 * per-uid on the ledger and go no further. The author is the peer with the most
 * characters this session (a human by construction), falling back to the last
 * writer, then to nobody.
 *
 * A review item is not always a block the document holds: a removed block is
 * stated under its own id with no print, and the title under
 * {@link TITLE_REVIEW_KEY}. Drupal reviews both, so both need their writers
 * named or they land approvable by nobody.
 */
export interface SessionWindow {
  /** Review item => its writer set (membership only). */
  blocks: Record<string, WriterRef[]>
  /** The human this revision is filed under. */
  author: AttributionPeer | null
  /** Everyone the window carries, for the revision log — text and fields both,
   *  each with the agent label it wrote under. */
  coAuthors: CoAuthor[]
  /** Block id => the print stated for it, `null` for one Drupal's body no
   *  longer holds, for the discharge print-comparison. */
  stated: Map<string, string | null>
  /** The sign-offs this checkpoint carries, on items still holding their print. */
  actions: { item: string, step: ReviewStep, uid: number }[]
}

/**
 * A block's print as a window states it, `null` for one Drupal's body does not
 * hold — a block the document dropped, and one emptied to what Drupal's
 * segmentation drops ({@link holdsNothing}). Both read the same way on
 * Drupal's side: the id left the body, so the change under review is a removal.
 */
function statedPrint(ledger: Ledger, id: string): string | null {
  const at = ledger.baseline.get(id)
  return at === undefined || at.empty ? null : at.print
}

/** Whether a block's content is back to what Drupal already holds. */
function backToStored(ledger: Ledger, id: string): boolean {
  return (ledger.committed.get(id) ?? null) === statedPrint(ledger, id)
}

/** Drops open-episode sets for blocks back to Drupal's stored content. */
function pruneStored(ledger: Ledger): void {
  for (const id of ledger.sets.keys()) {
    if (backToStored(ledger, id)) ledger.sets.delete(id)
  }
}

/**
 * `titleDirty` says the fields lane's title differs from what Drupal holds. The
 * lane keeps its writers for the whole lane rather than per key, so the caller
 * — which has the document — is the one that can tell.
 */
export function sessionWindow(ledger: Ledger, titleDirty = false): SessionWindow {
  const blocks: Record<string, WriterRef[]> = {}
  const stated = new Map<string, string | null>()
  const byUid = new Map<number, AttributionPeer>()
  // Keyed by writer, not by account: one person may write both in a seat and
  // through an agent, and only the second is named in the log.
  const writing = new Map<string, WriterRef>()

  for (const [id, set] of ledger.sets) {
    if (backToStored(ledger, id)) continue
    // A block gone from Drupal's body has no print to state. Its writers are
    // stated all the same: Drupal reviews the removal, and a change whose
    // writers nobody states is approvable by nobody (ADR 0004).
    const print = statedPrint(ledger, id)
    blocks[id] = [...set.writers.values()].map(w => ({ uid: w.uid, via: w.via }))
    stated.set(id, print)
    for (const w of set.writers.values()) {
      const peer = ledger.peers.get(w.uid)
      if (!peer) continue
      byUid.set(w.uid, peer)
      writing.set(writerKey(w), w)
    }
  }
  // A field edit moves no block, so it reaches the log through its own lane.
  // It reaches the review model through the same lane: the title is reviewed
  // like a block, and Drupal needs its writers named or the change lands
  // unaccounted. The author election below weighs text and is untouched.
  const fieldWriters = [...ledger.fieldWriters.values()]
  if (titleDirty && fieldWriters.length > 0) {
    blocks[TITLE_REVIEW_KEY] = fieldWriters.map(w => ({ uid: w.uid, via: w.via }))
  }
  for (const [key, w] of ledger.fieldWriters) {
    if (ledger.peers.has(w.uid)) writing.set(key, w)
  }

  // Most characters this session first; a tie goes to the last writer, then the
  // lower uid — so the same window always names the same author.
  const ranked = [...byUid.values()].sort((a, b) =>
    (ledger.totals.get(b.uid) ?? 0) - (ledger.totals.get(a.uid) ?? 0)
    || Number(b.uid === ledger.writer?.uid) - Number(a.uid === ledger.writer?.uid)
    || a.uid - b.uid,
  )
  const author = ranked[0] ?? (ledger.writer === null ? null : ledger.peers.get(ledger.writer.uid) ?? null)
  const named = [...writing.values()].sort((a, b) =>
    (ledger.totals.get(b.uid) ?? 0) - (ledger.totals.get(a.uid) ?? 0)
    || Number(b.uid === ledger.writer?.uid) - Number(a.uid === ledger.writer?.uid)
    || a.uid - b.uid
    || (a.via ?? '').localeCompare(b.via ?? ''),
  )
  // A sign-off answers for the text the reviewer read. Edited since, it is not
  // that text any more, and the edit has re-opened the step anyway — so the
  // action is dropped here rather than sent for Drupal to puzzle over. An item
  // the document holds no block for was read as `null` and still reads so.
  const actions = ledger.actions
    .filter(a => statedPrint(ledger, a.item) === a.print)
    .map(({ item, step, uid }) => ({ item, step, uid }))

  return {
    blocks,
    author: author ?? null,
    coAuthors: named.map(w => ({
      name: ledger.peers.get(w.uid)?.name ?? `uid ${w.uid}`,
      via: w.via,
    })),
    stated,
    actions,
  }
}

/**
 * The statement a checkpoint carries.
 *
 * Only a checkpoint going out over this server's own connection states one
 * (ADR 0001): Drupal reads a statement nowhere else, so an agent ending its
 * session under its own token sends text alone and the window it did not state
 * waits for the next checkpoint this server sends. Drupal credits from the
 * set, a `via` entry raising the agent step, so an agent-only session's writing
 * is stated here like anyone else's (ADR 0003).
 *
 * `acting` is who the write is performed as: the peer who triggered it, or —
 * where nobody did — the human the window elected. Drupal switches to them, so
 * the write answers to their rights and not to this server's.
 *
 * `actions` are the sign-offs peers made during the window, each under the
 * uid of the connection it arrived on. Drupal decides what each may record.
 *
 * An empty window is still stated. It is what a checkpoint says when its
 * ledger was lost, and the changed blocks it cannot name are exactly ADR
 * 0004's unaccounted case — approvable by nobody until an identified edit
 * re-stamps them. Withholding the statement instead would credit the service
 * account for text nobody witnessed it write.
 */
export function sessionPayload(
  window: SessionWindow,
  acting: number | null,
): {
  actingUid: number | null
  coAuthors: CoAuthor[]
  blocks: SessionWindow['blocks']
  actions: SessionWindow['actions']
} {
  return {
    actingUid: acting ?? window.author?.uid ?? null,
    coAuthors: window.coAuthors,
    blocks: window.blocks,
    actions: window.actions,
  }
}

/**
 * Drops exactly the blocks Drupal stored, leaving anything edited since.
 *
 * The committed print advances to the STATED print for every stated block —
 * that is what Drupal now holds, whatever happened here since. A block still
 * equal to it has landed and its set is dropped; one edited while the PATCH
 * was in flight keeps its set and rides the next checkpoint — and if that
 * in-flight edit is later undone, the block is back to Drupal's content and
 * opens no episode. Character totals reset: the next window elects its own
 * author (a re-stated block's writers keep membership, never amounts). Called
 * only for a checkpoint Drupal took; a window that never landed stays owed.
 */
export function dischargeWindow(ledger: Ledger, window: SessionWindow): void {
  for (const [id, statedPrint] of window.stated) {
    // A block stated as gone leaves the committed map: absent on both sides is
    // what backToStored() reads as landed, so the removal's set is dropped
    // instead of riding every checkpoint after it.
    if (statedPrint === null) ledger.committed.delete(id)
    else ledger.committed.set(id, statedPrint)
  }
  pruneStored(ledger)
  ledger.totals.clear()
  // Every sign-off this window carried has had Drupal's answer, and one it
  // dropped for a moved print will never become good again.
  ledger.actions.length = 0
}

/**
 * Drops the fields lane's writer set once the lane matches Drupal again.
 *
 * A field still dirty after the commit is one edited while the PATCH was in
 * flight, so its writers stay named and ride the next checkpoint — the same
 * posture the block sets take, decided over the whole lane because a checkpoint
 * writes every dirty field at once.
 */
export function dischargeFieldWriters(ledger: Ledger, fieldsDirty: boolean): void {
  if (!fieldsDirty) ledger.fieldWriters.clear()
}
