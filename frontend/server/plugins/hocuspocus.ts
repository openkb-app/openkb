import { defineNitroPlugin, useRuntimeConfig } from 'nitropack/runtime'
import { Hocuspocus } from '@hocuspocus/server'
import { SQLite } from '@hocuspocus/extension-sqlite'
import * as Y from 'yjs'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { flushPendingStores } from '../utils/hocuspocus'
import { commitDocument, mergeCommitHooks, type CommitIdentity, type CommitResult } from '../utils/commit'
import { drupalGateDeps, validateFieldValues, type RouterDeps } from '../utils/session-router'
import { closeAgentSessions } from '../utils/agent-sessions'
import { dirtyFieldKeys, fieldsCommitHooks } from '../utils/commit-fields'
import { blockIdCommitHooks } from '../utils/commit-block-ids'
import { seedBlockMeta, seedFromDrupal, type SeedDeps, type SeedOutcome } from '../utils/doc-seed'
import { sharedFieldSource } from '../utils/drupal-fields'
import { fetchCeWorkingCopy, fetchInlineComments, putInlineComments, type CePageRead } from '../utils/drupal'
import { asCollabServer, collabAuthHeaders, collabIdentityConfigured, forgetCollabToken } from '../utils/collab-identity'
import { adoptSnapshot, blockPrints, creditWriter, dischargeFieldWriters, dischargeWindow, hydrateLedger, isPeerUpdate, ledgerSnapshot, newLedger, reviewActionFrom, sessionPayload, sessionWindow, sharedIdKeepers, writerKey, writerOfOrigin, type Ledger, type LedgerSnapshot } from '../utils/collab-attribution'
import { isAgentOrigin } from '../utils/agent-peer'
import { initProseMirrorDoc } from '@tiptap/y-tiptap'
import type { Node as ProseNode } from '@tiptap/pm/model'
import { editorSchema } from '../utils/editor-schema'
import { readBlockMeta } from '#shared/page-blocks'
import { pruneComments } from '#shared/block-comments'
import { commentRecords, commentsSynced, type StoredConversations } from '../utils/collab-comments'
import { mapCeFieldValues, TITLE_KEY, type FieldValues } from '../utils/entity-fields'
import { CheckpointScheduler } from '../utils/commit-scheduler'
import { settleDocument, unloadMayRelease, type CollabControl, type CollabControlDeps, type SettleableDocument } from '../utils/collab-control'
import { COLLAB_COMMIT_MAX_DIRTY_MS, COLLAB_COMMIT_QUIET_MS, COLLAB_MARK_THROTTLE_MS } from '../utils/collab-timing'
import { MarkMirror } from '../utils/collab-sidecar'
import { noEditAccessReason, noFieldAccessReason } from '#shared/utils/collab-auth'
import { joinAccessUrl, parseJoinAnswer, type JoinAccount } from '../utils/collab-join'

/**
 * Collaboration server.
 *
 * Storage model — two layers:
 *   - Hot: Y.Doc binary, persisted to SQLite by @hocuspocus/extension-sqlite.
 *     Continuous, fine-grained, crash-safe. NOT a Drupal revision.
 *   - Cold: committed markdown in Drupal. Written by the one server-side
 *     commit service (server/utils/commit.ts) — from the manual Save RPC
 *     (POST /api/node/<nid>/commit) and from the auto-checkpoint triggers
 *     below (last-peer-disconnect + quiet/max-dirty timers). Drupal is the
 *     source of truth at rest; one commit, one revision.
 *
 * Document shape: the `default` XmlFragment holds the body, the `fields` Y.Map
 * holds the node title and every field the `frontmatter` form display exposes
 * (server/utils/entity-fields.ts), and `_meta` below carries the coordination
 * state. Fields are seeded from Drupal on the same session-less reconcile as
 * the body.
 *
 * Coordination via Y.Doc `_meta` map (synced to every connected client):
 *   - drupal_changed         (number)  Drupal's `changed` for the latest
 *                                      revision the live session knows about.
 *                                      Bumped on successful commit.
 *   - last_save_at           (number)  Wall clock of the last successful
 *                                      commit — the "Saved Xs ago" chip.
 *   - last_commit_hash       (string)  sha256 of the last committed markdown.
 *                                      The commit service's dirty check: equal
 *                                      hash ⇒ nothing to write. Seeded on load
 *                                      from Drupal's body so a freshly-hydrated
 *                                      unchanged doc is clean (zero revisions).
 *   - last_commit  ({ at, changed, hash, trigger })  Confirmed-checkpoint
 *                                      signal. Clients observe `last_commit.at`
 *                                      to clear their y-indexeddb mirror only
 *                                      after a commit Drupal accepted.
 *   - commit_error ({ at, kind, message, fields, trigger })  Last failed
 *                                      commit (e.g. 422 validation) surfaced to
 *                                      peers; `fields` maps JSON:API field
 *                                      names to messages for the Frontmatter-
 *                                      Form's per-field error slots. Cleared
 *                                      on the next successful commit.
 *   - fields_baseline        (object)  Drupal's values for the exposed fields
 *                                      at seed time, keyed by frontmatter key.
 *                                      The commit's field diff measures the
 *                                      session's edits from it.
 *   - external_change_detected ({ actual, at, fields })  Set when Drupal refuses
 *                                      a commit as stale (409) — an agent or
 *                                      another tab PATCHed via JSON:API while
 *                                      the session was live. `fields`, when
 *                                      present, names the frontmatter keys that
 *                                      moved away from `fields_baseline`.
 *                                      Clients observe and show the
 *                                      external-change banner. Cleared once
 *                                      `drupal_changed` catches up.
 *   - reset_at               (number)  Stamp written when a session-less
 *                                      reconcile (seedFromDrupal) rewrote the
 *                                      prosemirror fragment from Drupal.
 *
 * Auto-checkpoints: CheckpointScheduler arms a per-doc quiet timer
 * (OKB_COLLAB_COMMIT_QUIET_MS) on every edit and a max-dirty backstop
 * (OKB_COLLAB_COMMIT_MAX_DIRTY_MS) once per dirty window; last-peer-disconnect
 * fires an immediate checkpoint. All route through commitDocument, which is
 * idempotent (the hash dirty-check makes an unchanged doc a no-op).
 *
 * Server-initiated credentials: a checkpoint, a seed and a conversation
 * statement all go out under this server's own OAuth client (ADR 0001,
 * server/utils/collab-identity.ts) — never a captured peer cookie. The session
 * cookie captured in onAuthenticate is still re-verified before a checkpoint
 * (sessionStillValid): a session whose access has died must not have its
 * keystrokes made durable. The manual RPC runs under the caller's own cookie,
 * and an agent ending its session under its own token.
 *
 * Who wrote what is stated on this server's connection and no other. A
 * caller-carried write therefore says nothing about its window, and the
 * checkpoint entry point below delivers that window itself, under the same
 * trigger, before it answers the caller.
 *
 * Auth: parses the `node:<nid>` document namespace, reads the Drupal session
 * cookie from the WS handshake, and calls Drupal's join gate
 * (`GET /openkb/node/<nid>/join-access`), which answers node update access,
 * the session fields this account may not edit, and who the account is.
 *
 * Hosting constraints (embedded-in-Nitro mode):
 *   - The SQLite snapshot (HOCUSPOCUS_SQLITE, default `var/hocuspocus.sqlite`)
 *     is the only crash-safe copy of uncommitted edits. In hosted envs its
 *     directory MUST be a persistent volume; a lost snapshot silently drops
 *     everything since the last manual Save-to-history. When we go
 *     multi-env, the designated replacement is `@hocuspocus/extension-database`
 *     reusing the project DB — SQLite stays fine single-replica.
 *     `extension-sqlite` brings `better-sqlite3` as a regular dependency.
 *   - Exactly ONE replica of this server may run. Y.Doc state is held
 *     in-process; a second replica split-brains every document. See the
 *     deploy notes in the repo README ("Hosting the collab server").
 *   - Embedded mode (we construct `Hocuspocus`, not the built-in `Server`)
 *     never fires the `onRequest` / `onUpgrade` / `onListen` hooks — the
 *     HTTP/WS upgrade lives in Nitro (`routes/collaboration.ts`). Check
 *     this before adopting any new hocuspocus extension: an extension that
 *     relies on those hooks will silently do nothing here.
 */

/** What one join-access read tells the gate about a cookie and a node. */
interface JoinAccess {
  /** Node update, as Drupal decided it for this account. */
  allowed: boolean
  /** Session fields this account may not edit; null when Drupal did not say. */
  denied: string[] | null
  /** The account behind the cookie, as Drupal names it. */
  user: JoinAccount | null
}

const CACHE_TTL_MS = 60_000
/**
 * How long one read of the working copy answers for the whole seed pass.
 *
 * A seed pass asks the same revision five separate questions — `changed`, body,
 * fields, the block-meta sidecar, the uuid — and they must all describe ONE
 * revision or the lanes disagree (see fetchWorkingCopy) — they are all answered
 * off one CE read. Long enough to span a pass, short enough that every
 * checkpoint still reads Drupal fresh.
 */
const WORKING_COPY_MEMO_MS = 1_000
/**
 * The statuses that mean Drupal decided this session may not edit this node.
 * A non-OK status outside this set is something that never reached the access
 * system at all — see canEdit.
 */
const ACCESS_DENIAL_STATUSES = new Set([401, 403])
/**
 * The key the attribution snapshot is signed with.
 *
 * The snapshot syncs to clients like any Y type, so adoption has to trust only
 * what this server provably wrote. Signing is entirely between the server and
 * its own store — Drupal never sees a signature — so the server's own client
 * secret is the key: one credential, no committed default, nothing else to
 * keep in sync. Without one, nothing is signed and nothing is adopted.
 */
const SNAPSHOT_KEY = process.env.OKB_COLLAB_CLIENT_SECRET ?? ''

function resolveSqlitePath(): string {
  const raw = process.env.HOCUSPOCUS_SQLITE
  if (raw && raw.length > 0) {
    return isAbsolute(raw) ? raw : resolve(process.cwd(), raw)
  }
  return resolve(process.cwd(), 'var/hocuspocus.sqlite')
}

export default defineNitroPlugin((nitroApp) => {
  const config = useRuntimeConfig()
  const DRUPAL_URL = (config.drupalBaseUrl as string).replace(/\/$/, '')
  const SQLITE_PATH = resolveSqlitePath()

  mkdirSync(dirname(SQLITE_PATH), { recursive: true })

  const editPermCache = new Map<string, { access: JoinAccess, expiresAt: number }>()
  // One read of a node's working copy, shared by every lane of the seed pass
  // that follows it (see WORKING_COPY_MEMO_MS). Holds the in-flight promise, so
  // concurrent lanes share the request rather than merely its result.
  const workingCopyMemo = new Map<number, { read: Promise<CePageRead | null>, expiresAt: number }>()
  // Most recent authenticated session context per document — replayed by the
  // auto-checkpoint triggers, which have no request of their own (see the
  // "Auto-trigger credentials" note in the header comment).
  const sessionContext = new Map<string, CommitIdentity>()
  // Per-document attribution: who wrote which block, witnessed here (see
  // server/utils/collab-attribution.ts). Which peer a checkpoint credits by
  // itself is derived from that checkpoint's own credential (carrierOf),
  // not tracked here — "whoever authenticated last" is a different account the
  // moment a second editor joins.
  const ledgers = new Map<string, Ledger>()
  // The live review-mark mirror: the flags an edit earns reach the session's
  // sidecar without waiting for the checkpoint that makes them durable. It
  // only reads the document and its ledger; when it runs is its own.
  const markMirror = new MarkMirror({
    throttleMs: COLLAB_MARK_THROTTLE_MS,
    document: name => (hp.documents.get(name) as unknown as Y.Doc | undefined) ?? null,
    ledger: name => ledgers.get(name) ?? null,
  })
  // How many sessions have authenticated for a document, and the count as it
  // stood when an unload began. Teardown runs behind an await that the next
  // session can arrive inside, and the two are told apart by nothing else:
  // both hold the same document name, and the state the departing one is
  // releasing is the state the arriving one has just established.
  const claims = new Map<string, number>()
  const unloadingAt = new Map<string, number>()
  // In-flight idle reseeds, so two editors arriving together reconcile once.
  const idleSeeds = new Map<string, Promise<void>>()
  // Documents whose node is being deleted, each against the page it was
  // holding when it stood down. Nothing may schedule a checkpoint for them any
  // more — see server/utils/collab-control.ts for why a PATCH racing the
  // DELETE is a 500 rather than a merge.
  //
  // Ids are never reissued in normal operation (a store outliving its
  // database is an ops error — ADR 0008), so a retirement simply stands until
  // the process ends: one entry per deleted page.
  const retired = new Set<string>()
  // Assigned right after `hp` exists (its commit callback closes over hp); the
  // Hocuspocus hooks below only reference it at event time, never at construct.
  let scheduler: CheckpointScheduler

  function cacheKey(cookie: string | undefined, nid: number): string {
    const hash = createHash('sha256').update(cookie ?? '').digest('hex').slice(0, 16)
    return `${hash}:${nid}`
  }

  /**
   * This server's own identity as a commit carrier, or none when it has no
   * OAuth client configured — a checkpoint then reports `no-credentials`
   * rather than writing under somebody else's name.
   */
  async function collabCommitIdentity(): Promise<CommitIdentity | undefined> {
    const bearer = (await collabAuthHeaders()).Authorization?.replace(/^Bearer /, '')
    return bearer ? { token: bearer } : undefined
  }

  /**
   * The field values the reconcile/seed lane works from, mapped off the props
   * of the working-copy read the body lane already made — one revision for
   * both lanes, and no request of its own. Only the specs come from elsewhere
   * (`GET /openkb/schema`, cached).
   */
  async function fetchWorkingCopyFields(nid: number): Promise<FieldValues | null> {
    const read = await fetchWorkingCopy(nid)
    if (!read) return null
    const specs = await fieldSource.fetchSpecs()
    return specs === null ? null : mapCeFieldValues(specs, read.props)
  }

  /**
   * The revision the reconcile/seed lane compares against: the **working
   * copy**, read as this server (ADR 0001).
   *
   * It has to be the same revision the commit service writes and compares
   * (server/utils/commit.ts). Reading the published default instead makes a
   * moderated page (OKB-64) look permanently divergent the moment a
   * checkpoint lands a forward draft: the seed would wipe the document back to
   * the published body — discarding the draft — and every following commit
   * would 409 against a `drupal_changed` it can never match.
   *
   * Anonymous cannot see a working copy, so a deployment that gave this server
   * no identity has nothing to compare and the lane reports "unknown" (null)
   * rather than guessing from the published revision.
   *
   * Every seed lane resolves from this ONE read — literally one, memoized for
   * WORKING_COPY_MEMO_MS so a pass costs a single request — body, `changed`,
   * the frontmatter values and the block-provenance sidecar alike. They
   * describe the same revision or they describe nothing: `field_block_meta`
   * is keyed by the block ids of its own revision's body, so a sidecar read
   * from the published default against a body read from the draft names ids
   * the document does not carry. The commit's coherence sweep drops exactly
   * those, and an untouched document then looks permanently dirty — a
   * checkpoint per visit.
   */
  async function fetchWorkingCopy(nid: number): Promise<CePageRead | null> {
    // Every lane of the seed pass runs through here, and at each of them a
    // null answer is indistinguishable from "Drupal has nothing to change" —
    // so a document read under no identity reconciles against nothing and
    // leaves no trace of having skipped it. Saying so is the only way that
    // state is readable from outside.
    if (!collabIdentityConfigured()) {
      console.warn(`[collab] node:${nid}: working copy not read — this server has no OAuth client configured`)
      return null
    }
    const hit = workingCopyMemo.get(nid)
    if (hit && hit.expiresAt > Date.now()) return hit.read
    const pending = (async () => {
      try {
        return await asCollabServer(auth => fetchCeWorkingCopy(auth, nid))
      }
      catch (err) {
        console.error('[collab] working-copy fetch failed:', (err as Error).message)
        return null
      }
    })()
    workingCopyMemo.set(nid, { read: pending, expiresAt: Date.now() + WORKING_COPY_MEMO_MS })
    return pending
  }

  async function fetchDrupalChanged(nid: number): Promise<number | null> {
    return (await fetchWorkingCopy(nid))?.page.changed ?? null
  }

  async function fetchDrupalBody(nid: number): Promise<string | null> {
    return (await fetchWorkingCopy(nid))?.page.body ?? null
  }

  async function fetchDrupalBlockMeta(nid: number): Promise<string | null> {
    return (await fetchWorkingCopy(nid))?.page.blockMeta ?? null
  }

  /**
   * The page's stored conversations, read as this server.
   *
   * A lane of its own rather than part of the working-copy read: conversations
   * are entities beside the page, not a field on it, so nothing about them
   * arrives with the body. The uuid does — and the seed needs it to tell an
   * page from the one that held this node id before it.
   *
   * Null is "could not ask" — no identity, or Drupal did not answer — and the
   * reconcile then leaves the document's conversations alone rather than
   * reading silence as "Drupal holds none".
   */
  async function fetchStoredComments(nid: number): Promise<StoredConversations | null> {
    if (!collabIdentityConfigured()) return null
    const read = await fetchWorkingCopy(nid)
    if (!read) return null
    try {
      const { messages } = await asCollabServer(auth => fetchInlineComments(auth, 'node', nid))
      return { uuid: read.page.id, messages }
    }
    catch (err) {
      console.error(`[collab] node:${nid}: conversations not read:`, (err as Error).message)
      return null
    }
  }

  /**
   * The conversation each document was last seen to have stated to Drupal.
   *
   * Only this server writes them, so a set that has not moved since the last
   * accepted statement is one Drupal already holds. In memory on purpose: a
   * restart states once more, which is a no-op, and that is cheaper than
   * another thing to persist and keep true.
   */
  const statedComments = new Map<string, string>()

  /**
   * States the document's whole conversation to Drupal.
   *
   * Runs at every checkpoint, whether or not the checkpoint had text to write:
   * a review pass is people reading and commenting, and a session that types
   * nothing would otherwise never deliver a word of it. A request of its own,
   * beside the commit — a note must not manufacture a forward draft on a
   * published page (ADR 0006).
   *
   * A full set, so there is nothing to owe: Drupal ends the request holding
   * exactly what the map holds. Which is also why a map that was never aligned
   * with Drupal must not be stated — it would delete what it never read.
   *
   * Under this server's own credential, so a review pass whose peers have all
   * gone still delivers what they said.
   */
  async function syncComments(documentName: string): Promise<void> {
    if (!collabIdentityConfigured()) return
    const nid = Number(/^node:(\d+)$/.exec(documentName)?.[1])
    const document = hp.documents.get(documentName)
    if (!Number.isFinite(nid)) return
    if (!document) {
      console.error(`[collab] ${documentName}: conversations not stated — the document is gone`)
      return
    }

    const doc = document as unknown as Y.Doc
    if (!commentsSynced(doc)) {
      console.warn(`[collab] ${documentName}: conversations not stated — the document was never seeded from Drupal`)
      return
    }
    const records = commentRecords(doc)
    const stated = JSON.stringify(records)
    if (statedComments.get(documentName) === stated) return
    try {
      await asCollabServer(auth => putInlineComments(auth, 'node', nid, records))
      statedComments.set(documentName, stated)
    }
    catch (err) {
      console.error(`[collab] ${documentName}: conversations not stated:`, (err as Error).message)
    }
  }

  /**
   * May this session edit this node — and did Drupal actually say so?
   *
   * `reachable` is the difference between "Drupal answered, and the answer is
   * no" and "Drupal did not answer". Collapsing the two makes every outage a
   * mass revocation: a denial closes sockets and refuses reconnects, so a
   * deploy blip or a restarting container would eject every collaborator and
   * keep them out for the cache's lifetime. An unreachable Drupal is therefore
   * never cached and never treated as a refusal — callers decide what to do
   * with an answer nobody gave.
   *
   * Only a status Drupal decided *access* with is a denial: a 200 whose answer
   * withholds update, a 401, a 403. Every other status came from something
   * that never consulted the access system — a 429 from a rate limiter, a 502
   * or 504 from a proxy, a 404 from a route that is not mounted yet on a
   * container still coming up. Reading those as "no" is the same mass
   * revocation by another door, and it is the wider door: the 5xx guard alone
   * leaves the whole 4xx range outside it.
   */
  async function canEdit(
    nid: number,
    cookie: string,
    fresh = false,
  ): Promise<JoinAccess & { reachable: boolean }> {
    const key = cacheKey(cookie, nid)
    const hit = editPermCache.get(key)
    if (!fresh && hit && hit.expiresAt > Date.now()) {
      return { ...hit.access, reachable: true }
    }

    const headers: Record<string, string> = { Accept: 'application/json' }
    if (cookie) headers.Cookie = cookie

    const access: JoinAccess = { allowed: false, denied: null, user: null }
    try {
      const res = await fetch(joinAccessUrl(DRUPAL_URL, nid), { headers })
      if (!res.ok && !ACCESS_DENIAL_STATUSES.has(res.status)) {
        console.error(`[collab] join-access check unreachable: HTTP ${res.status} for node ${nid}`)
        return { allowed: false, denied: null, user: null, reachable: false }
      }
      if (res.ok) {
        // One answer: node update, the fields out of reach, and who Drupal
        // authenticated (see utils/collab-join.ts).
        const answer = parseJoinAnswer(await res.json())
        access.allowed = answer.update
        access.denied = answer.denied
        access.user = answer.account
      }
    }
    catch (err) {
      console.error('[collab] join-access check failed:', (err as Error).message)
      return { allowed: false, denied: null, user: null, reachable: false }
    }

    editPermCache.set(key, { access, expiresAt: Date.now() + CACHE_TTL_MS })
    return { ...access, reachable: true }
  }

  /**
   * The document's attribution ledger, created on first use.
   */
  function ledgerFor(documentName: string): Ledger {
    let ledger = ledgers.get(documentName)
    if (!ledger) {
      ledger = newLedger()
      ledgers.set(documentName, ledger)
    }
    return ledger
  }

  /** The document's body as ProseMirror sees it — the unit the ledger measures. */
  function proseDocOf(document: Y.Doc): ProseNode {
    return initProseMirrorDoc(document.getXmlFragment('default'), editorSchema).doc
  }

  /** HMAC over the serialized snapshot — the map syncs to clients like any Y
   *  type, so adoption trusts only what this server provably wrote. */
  function signSnapshot(serialized: string): string {
    return createHmac('sha256', SNAPSHOT_KEY).update(serialized).digest('hex')
  }

  /**
   * Mirrors the ledger's durable half into the document (ADR 0005).
   *
   * The `_attribution` map rides the document's own SQLite snapshot, so open
   * episodes and Drupal's last-stored prints survive a restart with the text
   * they account for — the store never holds text newer than its accounting
   * by more than the un-flushed sliver, which fails closed. The write carries
   * no origin, so the boundary listener ignores it.
   */
  function persistAttribution(document: Y.Doc, ledger: Ledger): void {
    // Without a key there is nothing to sign, and an unsigned snapshot would
    // be adopted on the word of whoever wrote it last.
    if (!ledger.hydrated || SNAPSHOT_KEY === '') return
    const snap = ledgerSnapshot(ledger)
    const next = JSON.stringify(snap)
    const map = document.getMap('_attribution')
    if (map.get('snapshot') === next) return
    Y.transact(document, () => {
      map.set('snapshot', next)
      map.set('signature', signSnapshot(next))
    })
  }

  /**
   * The persisted durable half, or null when it is absent, unsigned, or not
   * this server's writing. A snapshot that fails verification or does not
   * parse to the expected shape is CORRUPTION and answers null — the ledger
   * then hydrates blind and the affected content fails closed (ADR 0004).
   */
  function persistedAttribution(documentName: string, document: Y.Doc): LedgerSnapshot | null {
    if (SNAPSHOT_KEY === '') return null
    const map = document.getMap('_attribution')
    const serialized = map.get('snapshot')
    const signature = map.get('signature')
    if (typeof serialized !== 'string' || typeof signature !== 'string') return null
    const expected = signSnapshot(serialized)
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      console.error(`[collab] ${documentName}: attribution snapshot failed verification — dropped to unwitnessed`)
      return null
    }
    try {
      const parsed = JSON.parse(serialized) as LedgerSnapshot
      if (typeof parsed !== 'object' || parsed === null
        || typeof parsed.sets !== 'object' || parsed.sets === null
        || typeof parsed.committed !== 'object' || parsed.committed === null
        || !Object.values(parsed.sets).every(w => Array.isArray(w))
        || !Object.values(parsed.committed).every(v => typeof v === 'string')) {
        console.error(`[collab] ${documentName}: attribution snapshot malformed — dropped to unwitnessed`)
        return null
      }
      return parsed
    }
    catch {
      console.error(`[collab] ${documentName}: attribution snapshot unparsable — dropped to unwitnessed`)
      return null
    }
  }

  /**
   * Books writing to the connection that carried it, for one document.
   *
   * The measurement has to happen at the writer boundary and *before* the
   * incoming update integrates, which is why this listens on Yjs's
   * `beforeTransaction` rather than on hocuspocus's `onChange`: onChange fires
   * after the update is applied, so a pass run there measures a document that
   * already contains the newcomer's first burst and books it to whoever typed
   * before them. Here the document still holds exactly what the outgoing writer
   * left, and the pass credits them for precisely that.
   *
   * Same seam, same reason, for the agent path: an update with no identity sets
   * the writer to null after the outgoing writer is paid, so agent growth is
   * absorbed into the baseline rather than handed to the last human.
   *
   * Cost is one fragment→ProseMirror conversion per writer *change*, and one
   * more per COLLAB_MARK_THROTTLE_MS of a burst for the review-mark mirror
   * (see MarkMirror, server/utils/collab-sidecar.ts).
   */
  function attachAttribution(documentName: string, document: Y.Doc, drupalBody: string | null, seedOutcome?: SeedOutcome): void {
    const ledger = ledgerFor(documentName)
    const fragment = document.getXmlFragment('default')

    // The fields lane's own accounting. A field edit moves no block, so the
    // print pass below cannot see it, and the revision log would have nobody to
    // name for a field-only checkpoint. Seeding and the server's own writes
    // carry no origin and credit nobody.
    document.getMap('fields').observe((_event, transaction) => {
      const writer = writerOfOrigin(transaction.origin)
      if (writer) ledger.fieldWriters.set(writerKey(writer), writer)
    })

    // The starting point, when it is knowable now. Three states, not two:
    // content already restored from the snapshot store (which is ahead of
    // Drupal, and is what this session will actually measure against); an
    // page Drupal *says* holds no body, where the first typing is real
    // authorship; and a page Drupal did not answer for at all. The third is
    // not the second — baselining an unknown document at zero reads every
    // character that arrives next as growth and hands the whole page to
    // whoever opened it first. An unknown starting point stays unknown, and the
    // writer boundary below baselines it once a peer's fill has landed.
    // A load-time reset rewrote the body to Drupal's — a snapshot describing
    // the pre-reset content would state phantom writers. Fresh start instead.
    const persisted = seedOutcome === 'reset' ? null : persistedAttribution(documentName, document)
    if (persisted && fragment.length > 0 && !ledger.hydrated) {
      // A restart mid-session: the open episodes and Drupal's last-stored
      // prints come back with the text they account for, so the undelivered
      // window is stated by this session's next checkpoint (ADR 0005).
      adoptSnapshot(ledger, proseDocOf(document), persisted)
    }
    else if (fragment.length > 0 || drupalBody?.trim() === '') {
      hydrateLedger(ledger, proseDocOf(document))
      if (seedOutcome === 'reset') persistAttribution(document, ledger)
    }

    document.on('beforeTransaction', (transaction: Y.Transaction) => {
      // Only somebody writing is a writer boundary. This server's own `_meta`
      // bookkeeping carries no origin, and treating it as one would reset the
      // writer to nobody several times a minute — and let the mirror write at
      // the end of a pass re-enter the pass that produced it.
      //
      // A write from outside any seat — the `.md` PUT, the MCP tools, an
      // agent's block write — is one of these boundaries like any other, and
      // for the same reason: it moves the document, so the writer it interrupts
      // has to be paid before its bytes land. Who it seats afterwards is the
      // origin's own answer (AgentOrigin.seat) — agents are seated with their
      // via and enter the writer sets like anyone else (ADR 0003).
      if (!isPeerUpdate(transaction.origin) && !isAgentOrigin(transaction.origin)) return
      // Somebody is writing, so the marks that writing earns are due.
      markMirror.schedule(documentName)
      // An out-of-seat actor never authenticated a socket, so nothing has told
      // the ledger its name yet. The origin carries it, Drupal-derived from the
      // credential the write was authorized under.
      const seat = isAgentOrigin(transaction.origin) ? transaction.origin.seat : null
      if (seat) ledger.peers.set(seat.uid, { uid: seat.uid, name: seat.name })
      const writer = writerOfOrigin(transaction.origin)
      // A seat-less write is never a hydration — the session router restores
      // Drupal's markdown in a transaction of its own, untagged, and every
      // tagged one is somebody writing. So an unhydrated ledger can take its
      // starting point right here, from the document as it stands before these
      // ops land, and measure them. Left unhydrated it would measure nothing,
      // the window would name nobody for blocks the actor just wrote, and
      // Drupal would stamp them approvable by nobody — permanently, on a
      // surface whose author is standing right there in the credential.
      if (isAgentOrigin(transaction.origin) && !ledger.hydrated) {
        hydrateLedger(ledger, proseDocOf(document))
      }
      // An empty fragment about to be filled is the first peer hydrating the
      // page from Drupal's markdown, not somebody typing it. Baseline it
      // once the fill has landed; nothing before that is ever attributed.
      const hydrating = !ledger.hydrated && fragment.length === 0
      const changed = (writer === null ? null : writerKey(writer)) !== (ledger.writer === null ? null : writerKey(ledger.writer))
      if (changed) accountFor(documentName, true)
      ledger.writer = writer
      if (hydrating) {
        queueMicrotask(() => {
          // Only if the fill actually landed. A peer's first update need not
          // carry it — a sync that moves nothing into the fragment is an
          // ordinary way for a session to open — and baselining an empty
          // document as though it had been seen reads the fill that follows as
          // growth. That hands whoever opened the page the authorship of
          // every block in it: a byline for text they never wrote, on the
          // surface that decides who may sign it off. The next transaction
          // asks again.
          if (fragment.length > 0) hydrateLedger(ledger, proseDocOf(document))
        })
      }
    })
  }

  /**
   * Re-takes the ledger's starting point after this server REWROTE the body.
   *
   * Only then: a reconcile that rewrote the fragment carries no transaction
   * origin, so the boundary listener ignores it and the baseline would go on
   * describing a document that no longer exists. The document now equals
   * Drupal's copy, so the open episodes and owed prints are cleared with it.
   * On every other outcome — in-sync, unavailable, a mere baseline advance —
   * the ledger is left ALONE: re-hydrating there would overwrite `committed`
   * with the prints of undelivered content and silently destroy an owed
   * window (the exact loss ADR 0005's persistence exists to prevent).
   */
  function rebaseAfterReseed(documentName: string, outcome: SeedOutcome): void {
    if (outcome !== 'reset') return
    const document = hp.documents.get(documentName)
    const ledger = ledgers.get(documentName)
    if (!document || !ledger?.hydrated) return
    hydrateLedger(ledger, proseDocOf(document as unknown as Y.Doc))
    ledger.sets.clear()
    persistAttribution(document as unknown as Y.Doc, ledger)
  }

  /**
   * Books the writing done since the last pass to the peer who did it.
   *
   * Runs at writer boundaries and before a checkpoint reads its window —
   * the ledger has to be complete first. `deferPersist` is for the caller
   * inside another transaction (attachAttribution): the measurement is a
   * synchronous read, the snapshot persist is a Y transaction of its own.
   */
  function accountFor(documentName: string, deferPersist = false): void {
    const document = hp.documents.get(documentName)
    const ledger = ledgers.get(documentName)
    if (!document || !ledger) return

    creditWriter(ledger, proseDocOf(document as unknown as Y.Doc))
    // The persist writes a Y transaction of its own, so it must not run
    // inside the boundary listener's transaction.
    const persist = () => persistAttribution(document as unknown as Y.Doc, ledger)
    if (deferPersist) queueMicrotask(persist)
    else persist()
  }

  /**
   * Takes Drupal's sidecar back into the live session.
   *
   * The one place that re-takes the mirror, called after every checkpoint —
   * the moment Drupal's copy is newer than the session's rather than older.
   * Drupal wrote the flags, the contributors, the four-eyes baselines and the
   * sign-offs the statement carried, all in the save that wrote the text;
   * anything this server mirrored while people typed was a running estimate of
   * the same thing.
   *
   * So the chips end up showing what the gate will actually enforce, and
   * nothing this session accumulated can drift away from it.
   */
  async function syncSidecarFromDrupal(documentName: string, wrote: boolean): Promise<void> {
    const nid = Number(/^node:(\d+)$/.exec(documentName)?.[1])
    if (!Number.isFinite(nid)) return

    // Drupal has just been written and the memoized working copy predates it,
    // so the sidecar re-read below would take back a copy without this very
    // checkpoint's flags — and hold it for the memo's lifetime.
    if (wrote) workingCopyMemo.delete(nid)

    const stored = await fetchDrupalBlockMeta(nid)
    const document = hp.documents.get(documentName)
    if (!document) return
    if (stored !== null) seedBlockMeta(document as unknown as Y.Doc, stored)
    // Conversations about blocks the page no longer holds. The sidecar gets
    // this sweep on Drupal's side and arrives already coherent; comments live
    // only in this document, so nothing else would ever drop them — and a
    // thread on a block nobody can read is one nobody can answer.
    //
    // A document holding no addressable blocks at all is not a page whose
    // blocks were deleted — it is one caught mid-flight, loaded from the
    // snapshot store before a peer hydrated it (the same window the commit
    // service's empty-body guard describes). Pruning against that reads as
    // "every block is gone" and takes every conversation with it, which is the
    // one outcome this sweep must never produce.
    const present = new Set(blockPrints(proseDocOf(document as unknown as Y.Doc)).keys())
    if (present.size > 0) pruneComments(document as unknown as Y.Doc, present)
  }

  /**
   * Whether the document's captured session still holds, asked of Drupal.
   *
   * A checkpoint is the moment a session's keystrokes become durable facts —
   * a revision, and with it the block flags and contributor records Drupal
   * stamps. Those must not be written under a credential that has since been
   * logged out, expired or had its access revoked, so the cookie is re-verified
   * here rather than trusted for the lifetime of the socket. Cache-bypassing:
   * the 60s permission cache is a rate limiter for keystroke-time checks, not
   * an answer to "does this session still exist".
   *
   * When it does not, the sockets go: a peer whose session died keeps typing
   * into a document nobody will ever commit, and silently dropping their work
   * later is worse than telling them now. Their ops neither apply nor attribute
   * from that point.
   *
   * A Drupal that does not answer is not a session that died. Treating the two
   * alike turns every outage into a mass revocation — the checkpoint is skipped
   * either way, but only a real refusal may close sockets and refuse the
   * reconnects that follow. An unreachable Drupal costs a timer checkpoint and
   * nothing else; the next one asks again. On the last peer's checkpoint there
   * is no next one, so the commit service asks this again itself, bounded — see
   * TERMINAL_PRECONDITION_TRIES.
   */
  async function sessionStillValid(documentName: string): Promise<true | CommitOutcome> {
    const identity = sessionContext.get(documentName)
    // An agent checkpoint carries its own Bearer token, which Drupal
    // authenticates on the write itself.
    if (!identity?.cookie) return true
    const nid = Number(/^node:(\d+)$/.exec(documentName)?.[1])
    if (!Number.isFinite(nid)) return true

    const { allowed, reachable } = await canEdit(nid, identity.cookie, true)
    if (!reachable) {
      console.error(`[collab] ${documentName}: could not re-verify the captured session, checkpoint skipped`)
      return 'error'
    }
    if (!allowed) {
      sessionContext.delete(documentName)
      hp.closeConnections(documentName)
      console.error(`[collab] ${documentName}: captured session no longer valid, connections closed`)
      return 'unauthenticated'
    }
    return true
  }

  const fieldSource = sharedFieldSource(DRUPAL_URL)

  const seedDeps: SeedDeps = {
    fetchChanged: fetchDrupalChanged,
    fetchBody: fetchDrupalBody,
    fetchFields: fetchWorkingCopyFields,
    fetchBlockMeta: fetchDrupalBlockMeta,
    fetchComments: fetchStoredComments,
  }

  /**
   * onAuthenticate-time half of the session-less reconcile (see
   * server/utils/doc-seed.ts): only for a document still in memory with no
   * connections — unload lost the race against a store flush, a checkpoint's
   * `_meta` writes, or simply the next editor arriving fast enough, so
   * onLoadDocument never fires. Runs before the connection is set up,
   * so the reset lands ahead of the client's sync — resetting later (in
   * `connected`, which fires after queued sync messages are handled) would
   * empty an editor that has already hydrated from the stale state.
   */
  function seedIdleDocument(documentName: string): Promise<void> {
    const running = idleSeeds.get(documentName)
    if (running) return running

    const run = (async () => {
      const document = hp.documents.get(documentName)
      if (!document || document.isLoading || document.getConnectionsCount() > 0) return
      // Never race a checkpoint that is about to advance `drupal_changed`.
      await scheduler.waitIdle(documentName)
      if (document.getConnectionsCount() > 0) return
      // An idle reseed exists because Drupal may have moved while nobody was
      // connected — the memo the last checkpoint left (its own body, within
      // WORKING_COPY_MEMO_MS) must not answer it, or an external write in
      // that window reads as "nothing changed" and the stale copy survives.
      const nid = Number(/^node:(\d+)$/.exec(documentName)?.[1])
      if (Number.isFinite(nid)) workingCopyMemo.delete(nid)
      const outcome = await seedFromDrupal(documentName, document as unknown as Y.Doc, seedDeps, 'idle')
      rebaseAfterReseed(documentName, outcome)
    })().finally(() => { idleSeeds.delete(documentName) })

    idleSeeds.set(documentName, run)
    return run
  }

  /** Whether this document is stood down for a delete. */
  function isRetired(documentName: string): boolean {
    return retired.has(documentName)
  }

  const hp = new Hocuspocus({
    extensions: [new SQLite({ database: SQLITE_PATH })],

    async onAuthenticate({ documentName, token, requestHeaders }) {
      const match = /^node:(\d+)$/.exec(documentName)
      if (!match) {
        throw new Error(`Document namespace not allowed: ${documentName}`)
      }
      const nid = Number(match[1])
      if (!Number.isFinite(nid) || nid <= 0) {
        throw new Error(`Invalid node id in document name: ${documentName}`)
      }

      // A credential the client hands in is a credential the client chose.
      // Identity here is derived, never declared: the handshake is an ordinary
      // HTTP request on the app origin, so the HttpOnly session cookie rides it
      // on its own and no script can read it, substitute it, or borrow
      // somebody else's. Anything arriving in the handshake payload instead —
      // an agent's Bearer token above all — is refused: the socket seats only
      // writers this server derived an identity for. It is not a rule about
      // agents. An agent is a CRDT peer like any other, joined in-process
      // through the agent adapter, where the session router admits it and its
      // ops carry their own attributed origin (ADR 0003).
      if (token) {
        const reason = 'This editing session takes the browser session only; agent credentials join through the agent API.'
        throw Object.assign(new Error(reason), { reason })
      }
      const rh = requestHeaders as unknown as (Headers | Record<string, string>)
      const cookie = (typeof (rh as Headers)?.get === 'function'
        ? (rh as Headers).get('cookie')
        : (rh as Record<string, string>)?.cookie) || ''
      if (!cookie) {
        throw new Error('Authentication required: no session cookie')
      }

      const { allowed, denied, user, reachable } = await canEdit(nid, cookie)
      if (!reachable) {
        // Drupal did not answer. Refusing is the only safe move — but it is a
        // refusal of the moment, not of the account, and it caches nothing, so
        // a retry once Drupal is back is granted immediately.
        const reason = 'Could not reach the site to check your access — try again in a moment.'
        throw Object.assign(new Error(reason), { reason })
      }
      if (!allowed) {
        // A cookie Drupal no longer honours (expired/stale session) resolves
        // to the anonymous user — that is a sign-in problem, not a permission
        // problem, so throw without `reason` and the client keeps the generic
        // "Not signed in".
        if (!user || !user.uid) {
          throw new Error(`Session not authenticated for node ${nid}`)
        }
        // Hocuspocus transmits `err.reason` (not `err.message`) to the client's
        // onAuthenticationFailed — without it the browser only ever sees the
        // generic "permission-denied" and can't tell "not signed in" from
        // "signed in but no access".
        throw Object.assign(new Error(noEditAccessReason(nid)), { reason: noEditAccessReason(nid) })
      }
      // Update access is not the whole of admission: a field this account may
      // not edit is a field it must not reach through the shared document
      // either. The gate answered both and logged the refusal; a missing
      // answer is refused too (see utils/collab-join.ts).
      if (denied === null || denied.length > 0) {
        const reason = noFieldAccessReason(nid, denied)
        throw Object.assign(new Error(reason), { reason })
      }
      // Capture the session context so an auto-checkpoint (which has no
      // request of its own) can replay this cookie against Drupal's JSON:API.
      // The user name rides along, server-derived from the same gate call —
      // it is connection context only; the client's awareness identity comes
      // from /api/me, since this return value never reaches the browser.
      sessionContext.set(documentName, { cookie, user: user?.name })
      // This session's claim on the document, so a previous one's teardown can
      // tell the state it is releasing from the state this just established.
      claims.set(documentName, (claims.get(documentName) ?? 0) + 1)
      // The account behind this socket, so the ledger can name it when it books
      // what the socket writes. Identity only — a peer's own credential is
      // never needed for attribution, because the checkpoint states the whole
      // window itself (see collab-attribution.ts).
      if (user?.uid) {
        ledgerFor(documentName).peers.set(user.uid, { uid: user.uid, name: user.name })
      }
      // Warm-but-idle document: reconcile with Drupal here, while no peer is
      // connected and before this connection syncs (see seedIdleDocument).
      await seedIdleDocument(documentName)
      return { user: user ?? { name: 'editor', uid: 0 } }
    },

    async onLoadDocument({ documentName, document }) {
      const seedOutcome = await seedFromDrupal(documentName, document, seedDeps)
      const nid = Number(/^node:(\d+)$/.exec(documentName)?.[1])
      if (!Number.isFinite(nid)) return
      // Free: the seed pass above just read the working copy, and this read
      // resolves from the same memoized answer.
      attachAttribution(documentName, document, await fetchDrupalBody(nid), seedOutcome)
    },

    /**
     * A peer signing a block off — an act, recorded under their connection.
     *
     * The document is a shared buffer every peer may write and awareness is
     * client-declared, so neither can carry who signed off. The connection can:
     * `onAuthenticate` resolved it against Drupal, and it is the same identity
     * block credit already rides on (ADR 0001/0004). The sign-off is kept in
     * server memory, never in the doc, and goes to Drupal inside the next
     * checkpoint's statement — which this triggers. Drupal decides what it may
     * record and answers in `_meta.review`.
     */
    async onStateless({ documentName, connection, payload }) {
      if (!/^node:\d+$/.test(documentName) || isRetired(documentName)) return
      const document = hp.documents.get(documentName)
      if (!document) return
      const ydoc = document as unknown as Y.Doc
      const prints = blockPrints(proseDocOf(ydoc))
      // A removal and the title are review items the sidecar names and the
      // document holds no block for: they read as `null`, which is what the
      // window states for them, rather than as an unknown key.
      const items = new Set(Object.keys(readBlockMeta(ydoc)))
      const action = reviewActionFrom(
        payload,
        (connection.context as { user?: { uid?: number } })?.user?.uid ?? 0,
        item => prints.get(item)?.print ?? (items.has(item) ? null : undefined),
      )
      if (!action) return
      ledgerFor(documentName).actions.push(action)

      await scheduler.checkpoint(documentName, 'manual', { uid: action.uid })
    },

    // Every doc mutation re-arms the quiet timer (and arms the max-dirty
    // backstop once per window). Meta-only writes from a commit also land here
    // and harmlessly re-arm; the next quiet fire is a clean no-op.
    async onChange({ documentName }) {
      if (!/^node:\d+$/.test(documentName) || isRetired(documentName)) return
      scheduler.onActivity(documentName)

    },

    async onDisconnect({ documentName, clientsCount }) {
      if (/^node:\d+$/.test(documentName) && !isRetired(documentName)) {
        // Last peer leaving triggers an immediate checkpoint (idempotent).
        scheduler.onDisconnect(documentName, clientsCount)
      }
    },

    /**
     * The last gate before the document is destroyed: held until the
     * checkpoint still reading it is done.
     *
     *  - The last peer leaving fires a checkpoint nobody awaits, and the
     *    unload runs on the next tick — so `documents.delete` lands
     *    mid-checkpoint.
     *  - What the checkpoint has left to do resolves the document by name:
     *    the conversations it states after the body (ADR 0006), the sidecar
     *    re-read. Both are dropped, and dropped silently.
     *  - Hocuspocus's own unload guard counts connections and pending stores.
     *    An in-flight checkpoint is neither.
     *
     * This hook is awaited before the delete, so waiting here holds the
     * document open for its own last write. Nothing is stranded: the unload
     * re-checks its guard afterwards, and a peer that arrived meanwhile
     * cancels it.
     */
    async beforeUnloadDocument({ documentName }) {
      unloadingAt.set(documentName, claims.get(documentName) ?? 0)
      await scheduler.waitIdle(documentName)
    },

    /**
     * Everything this server was holding for one document, released with it —
     * the captured session cookie above all, a live credential with no
     * business outliving the editing it authenticated.
     */
    async afterUnloadDocument({ documentName }) {
      const unloadedAt = unloadingAt.get(documentName)
      unloadingAt.delete(documentName)
      await scheduler.waitIdle(documentName)
      // The wait above is long enough for the next session to arrive, and its
      // onAuthenticate has already put this document's state back. Dropping
      // what was claimed after the unload began takes it from that session,
      // not from the one that left: its ledger loses the baseline its window
      // is measured against, and its checkpoint has no captured session to
      // re-verify before making the burst durable.
      if (!unloadMayRelease(unloadedAt, claims.get(documentName) ?? 0)) return
      ledgers.delete(documentName)
      markMirror.stop(documentName)
      sessionContext.delete(documentName)
      idleSeeds.delete(documentName)
      claims.delete(documentName)
      statedComments.delete(documentName)
      const nid = Number(/^node:(\d+)$/.exec(documentName)?.[1])
      if (Number.isFinite(nid)) workingCopyMemo.delete(nid)
    },
  })

  /**
   * Whether the document's title differs from what Drupal holds.
   *
   * The title is reviewed like a block, so its writers have to be stated with
   * the window — and the fields lane names its writers for the whole lane, so
   * this is what says the title is among them.
   */
  function titleIsDirty(hp: Hocuspocus, documentName: string): boolean {
    const held = hp.documents.get(documentName)
    return held !== undefined && dirtyFieldKeys(held as unknown as Y.Doc).includes(TITLE_KEY)
  }

  // Auto-checkpoint scheduler. Its commit callback carries every checkpoint
  // under this server's own token except an agent's, which brings its own. The
  // fields hooks put entity-field edits into every checkpoint's payload, so a
  // disconnect checkpoint persists a field-only change too.
  scheduler = new CheckpointScheduler({
    quietMs: COLLAB_COMMIT_QUIET_MS,
    maxDirtyMs: COLLAB_COMMIT_MAX_DIRTY_MS,
    commit: async (documentName, trigger, identity) => {
      // An agent hands over its own token, and that write is the token
      // owner's: no statement, no account switch (ADR 0001). Every other
      // checkpoint goes out under this server's OAuth client and states who is
      // acting. The captured peer cookie is never replayed onto a write.
      const agentCarrier = identity?.token !== undefined
      const carrier = agentCarrier ? identity : await collabCommitIdentity()
      // The ledger has to be complete before the window is read off it, and the
      // pass is local work — no round trip, no race with the unload the commit
      // below guards against.
      accountFor(documentName)
      const ledger = ledgerFor(documentName)
      // What this checkpoint carries, taken here rather than after the write:
      // commitDocument serializes the body before its first await, and this is
      // the accounting for exactly that body.
      const window = sessionWindow(ledger, titleIsDirty(hp, documentName))
      const owed = Object.keys(window.blocks).length > 0
      // Whoever triggered this is who it acts as; one nobody triggered acts as
      // the human the window elected.
      const payload = agentCarrier ? undefined : sessionPayload(window, identity?.uid ?? null)
      const result = await commitDocument(hp, documentName, {
        trigger,
        // A caller that brought its own credential authenticated on this very
        // request; only the replayed session needs re-verifying.
        precondition: identity ? undefined : () => sessionStillValid(documentName),
        identity: carrier,
        // A session's checkpoint is not its carrier's save: it carries the
        // window's own accounting, and Drupal credits the peers it names and
        // writes as the human it names. Nothing on an agent's, which is that
        // token owner's ordinary save.
        sessionWrite: payload,
        // Fields and block ids ride the checkpoint payload.
        hooks: mergeCommitHooks(
          fieldsCommitHooks(fieldSource.fetchSpecs),
          // Two reasons to write that the body hash cannot see.
          //  - A window whose writers Drupal has not recorded yet: the text
          //    may already be in Drupal (an agent wrote it) and the credit is
          //    not durable until a checkpoint carries it. Drupal books it onto
          //    blocks this write leaves alone.
          //  - A stated sign-off: the checkpoint IS how a sign-off reaches
          //    Drupal, and a reviewer clearing a block types nothing.
          {
            dirtyChecks: [
              async () => payload !== undefined && (owed || payload.actions.length > 0),
            ],
          },
          // The pass above resolved every shared id against what the blocks
          // held before; the commit applies that rather than reading document
          // order, which is the client's to choose.
          blockIdCommitHooks(sharedIdKeepers(ledger.baseline)),
          // The sidecar mirror is re-taken in the post-commit lane, with the
          // other bookkeeping that writes to the doc: a doc write landing after
          // the confirmed-checkpoint signal resurrects the y-indexeddb mirror
          // the peers just cleared.
          // The postCommit lane runs only after a PATCH Drupal accepted.
          { postCommit: [async () => { await syncSidecarFromDrupal(documentName, true) }] },
        ),
      })
      // The window is owed until Drupal holds the bytes it accounts for. A
      // checkpoint that wrote nothing, failed, hit a conflict — or carried no
      // accounting at all — leaves its writer sets on the books to ride the
      // next one that does. Discharge drops only the blocks whose content still
      // equals what the window stated; a block edited while the PATCH was in
      // flight keeps its set and is re-stated, idempotently.
      //
      // `adopted` is the other way Drupal comes to hold them: a PATCH that
      // landed and whose response was lost, discovered on the next checkpoint
      // because the page now reads exactly as this document serializes. The
      // accounting rode that write, so the window is delivered — and what this
      // session believes Drupal stores has to advance with it, or a peer undoing
      // the delivered edit is measured against bytes Drupal replaced.
      if ((result.committed || result.adopted) && payload) {
        dischargeWindow(ledger, window)
        const held = hp.documents.get(documentName)
        if (held) {
          dischargeFieldWriters(ledger, dirtyFieldKeys(held as unknown as Y.Doc).length > 0)
          persistAttribution(held as unknown as Y.Doc, ledger)
        }
      }
      // A checkpoint that wrote nothing can still find Drupal's sidecar newer
      // than the session's: a moderation action or a revert moves the flags
      // with no checkpoint behind it. There is no confirmed-checkpoint signal
      // on this path, so the re-read is free of the ordering constraint that
      // puts it in postCommit above.
      if (result.outcome === 'clean') await syncSidecarFromDrupal(documentName, false)
      // The conversations, after the body: the sweep above has just dropped
      // the ones whose block has left, so the map being stated is the coherent
      // one. Unlike the window above they do not wait for a commit — a session
      // where people only read and comment writes no text and must still
      // deliver what was said (ADR 0006).
      if (result.outcome !== 'no-document' && result.outcome !== 'unauthenticated') {
        await syncComments(documentName)
      }
      // A token Drupal no longer honours — the consumer re-provisioned, the
      // keys rotated — reads as a 401 here. Drop it so the next checkpoint
      // issues a fresh one; this window stays owed until one lands.
      if (result.status === 401) forgetCollabToken()
      // An auto-checkpoint has nobody watching an HTTP response, and on a
      // disconnect there may be no peer left to render `commit_error` either —
      // a failed outcome silently loses the dirty window's edits unless it is
      // at least on record here.
      // `empty-body` already logged itself with the reason it skipped.
      if (!result.committed && result.outcome !== 'clean' && result.outcome !== 'empty-body') {
        console.error(
          `[collab] ${documentName}: ${trigger} checkpoint not committed (${result.outcome})`
          + (result.message ? `: ${result.message}` : '')
          + (result.fields ? ` ${JSON.stringify(result.fields)}` : ''),
        )
      }
      return result
    },
  })

  /**
   * Checkpoint one document for a caller.
   *
   * One write: the text, the window that accounts for it and the fact that the
   * caller asked go to Drupal together, as the caller.
   *
   * A node being deleted has nothing left to persist to, so a retired document
   * answers `no-document` rather than racing a PATCH against the DELETE.
   */
  function checkpoint(docName: string, trigger: CommitTrigger, identity: CommitIdentity): Promise<CommitResult> {
    if (isRetired(docName)) {
      return Promise.resolve({ outcome: 'no-document', committed: false } as CommitResult)
    }
    return scheduler.checkpoint(docName, trigger, identity)
  }

  console.log(`[collab] plugin init, sqlite at ${SQLITE_PATH}`)

  ;(nitroApp as unknown as { hocuspocus: Hocuspocus }).hocuspocus = hp

  // The one checkpoint entry point (see useCheckpoint). Everything that writes
  // a live session to Drupal — the manual Save RPC, publish, revert, a peer's
  // sign-off — comes through here and gets the whole checkpoint: the
  // attribution pass, the commit that carries its accounting, and the sidecar
  // re-read. A retired
  // document has nothing left to persist to, the same guard the agent router
  // gets below.
  ;(nitroApp as unknown as { okbCheckpoint: typeof checkpoint }).okbCheckpoint = checkpoint

  // Agent write path (OKB-61). The router needs the same three things a human
  // session does — the hocuspocus instance, the field schema, and a way to
  // checkpoint — and they all live in this closure. Handing them over here is
  // what keeps server/utils/session-router.ts free of nitro internals and unit
  // testable against stubs.
  ;(nitroApp as unknown as { okbAgentRouter: RouterDeps }).okbAgentRouter = {
    ...drupalGateDeps(),
    host: hp,
    fetchSpecs: fieldSource.fetchSpecs,
    validateValues: validateFieldValues,
    fetchBody: fetchDrupalBody,
    captureCarrier: (documentName, identity) => sessionContext.set(documentName, identity),
    checkpoint,
  }

  // Settle path (OKB-97): the delete route stands this server down for one
  // document before it DELETEs the node, so no checkpoint PATCH can be in
  // flight against a node being deleted. Same handoff shape as the agent
  // router — the scheduler and the retired set live in this closure, the
  // ordering logic lives in server/utils/collab-control.ts.
  const controlDeps: CollabControlDeps = {
    documents: hp.documents as unknown as Map<string, SettleableDocument>,
    retire: docName => retired.add(docName),
    disarm: docName => scheduler.disarm(docName),
    waitIdle: docName => scheduler.waitIdle(docName),
    closeConnections: docName => hp.closeConnections(docName),
    unload: document => hp.unloadDocument(document as unknown as Parameters<typeof hp.unloadDocument>[0]),
  }
  ;(nitroApp as unknown as { okbCollabControl: CollabControl }).okbCollabControl = {
    settle: async (docName) => {
      // Agents first: a held session is a direct connection the document cannot
      // be unloaded past, and a settle stands the document down precisely so
      // that nothing writes to the node — so they leave without persisting.
      await closeAgentSessions({ document: docName, persist: false })
      const report = await settleDocument(controlDeps, docName)
      // Only now: waitIdle needs the scheduler state that stop() drops.
      scheduler.stop(docName)
      console.log(
        `[collab] settled ${docName} for delete `
        + `(live: ${report.live}, connections closed: ${report.connections})`,
      )
      return report
    },
  }

  // Shutdown flush (idempotent): run every pending debounced onStoreDocument
  // so edits made within the store-debounce window (default 2s) reach SQLite
  // before the process dies. Reachable paths:
  //   - nitro `close` hook — programmatic close, dev-worker replacement, and
  //     (production node-server entry) SIGTERM/SIGINT via nitro's
  //     setupGracefulShutdown (disable via NITRO_SHUTDOWN_DISABLED).
  //   - process SIGTERM/SIGINT handlers — fallback for node entries without
  //     nitro's graceful shutdown. NOT reachable in `nuxt dev`: the dev
  //     server runs the nitro app in a worker thread, and POSIX signals are
  //     only dispatched to the main thread. Dev containers therefore wrap
  //     the server in frontend/scripts/dev-server.sh, which traps SIGTERM
  //     and triggers the flush via POST /api/collab/flush before exiting.
  // The signal handlers only flush; afterwards, if no other listener remains
  // for the signal, it is re-raised so default termination applies. When
  // nitro's own handler is present it keeps owning process lifetime.
  let shutdownDone: Promise<void> | null = null
  function shutdown(reason: string): Promise<void> {
    if (!shutdownDone) {
      console.log(`[collab] shutdown (${reason}): flushing document stores`)
      scheduler.stopAll()
      markMirror.stopAll()
      // The last sliver's accounting persists with its text (ADR 0005).
      for (const documentName of hp.documents.keys()) accountFor(documentName)
      // Agents leave the room without a checkpoint of their own: the flush
      // below puts what they wrote in the snapshot, and a shutdown is no time
      // to start a Drupal write.
      shutdownDone = closeAgentSessions({ persist: false })
        .then(() => flushPendingStores(hp))
        .then(count => console.log(`[collab] shutdown complete, ${count} document(s) flushed`))
        .catch(err => console.error('[collab] shutdown failed:', (err as Error).message))
    }
    return shutdownDone
  }

  nitroApp.hooks.hook('close', () => shutdown('nitro close'))

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      shutdown(signal).finally(() => {
        if (process.listenerCount(signal) === 0) {
          process.kill(process.pid, signal)
        }
      })
    })
  }
})
