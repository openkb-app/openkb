import * as Y from 'yjs'
import { createHash } from 'node:crypto'
import { Node as PMNode } from '@tiptap/pm/model'
import { yDocToProsemirrorJSON } from '@tiptap/y-tiptap'
import type { Hocuspocus } from '@hocuspocus/server'
import { editorSchema } from './editor-schema'
import { serializeDocToMarkdown } from '../../app/comark/markdown-engine'
import type { ReviewStep } from '#shared/page-blocks'
import type { ReviewOutcome } from './drupal'
import {
  commitKbPageWithAuth,
  fetchCeWorkingCopy,
  type KbPagePatchExtra,
} from './drupal'
import { storedBody } from './title-heading'
import { actorLabel } from '#shared/utils/attribution'

/**
 * Headless commit service — the server-side Y.Doc → markdown → single Drupal
 * write pipeline. One implementation for every trigger:
 *
 *   - manual RPC  (POST /api/node/:id/commit)
 *   - last-peer-disconnect and quiet/max-dirty auto-checkpoints
 *     (server/plugins/hocuspocus.ts)
 *   - agent session end (server/utils/session-router.ts, under the agent's
 *     own Bearer token)
 *
 * The first two go out under this server's own Bearer token and name the human
 * acting through it, so text, credit and the publish they asked for are one
 * write ({@link SessionWrite}). An agent hands over its own token: no
 * statement, and the write is the token owner's.
 *
 * Flow: (e) lane captures → yDocToProsemirrorJSON('default') → (a) pre-serialize
 * transforms → Node.fromJSON(editorSchema) → serializeDocToMarkdown → dirty
 * check (hash against _meta.last_commit_hash, plus (d) extra dirty predicates) →
 * (b) payload extenders → concurrency check (Drupal `changed` vs
 * _meta.drupal_changed) → commit route → update _meta → (c) post-commit hooks
 * → confirmed-checkpoint signal.
 *
 * Everything the revision asserts is read in the (e)/serialize prefix, which
 * awaits nothing: one revision is the document at one instant, by one actor.
 * The lanes that run later work from those captures, never the live document.
 *
 * The checkpoint signal is written last, on purpose: it is what makes a peer
 * drop its offline mirror, so no lane may write to the doc after it.
 *
 * The write itself is `POST /openkb/node/<nid>/commit` (openkb_agent), not a
 * JSON:API PATCH: moderated pages carry forward drafts, and JSON:API
 * refuses any write on an entity whose latest revision is not the default one
 * (core #2795279). The payload shape is unchanged — the extenders still
 * produce a JSON:API `{attributes, relationships}` fragment.
 *
 * No DOM, no jsdom, no browser — the schema (editor-schema.ts) and markdown
 * engine (app/comark/markdown-engine.ts) are the same definitions the browser
 * editor uses, so client and server serialize byte-identically.
 *
 * The seams keep the core field-agnostic: the OKB-48 entity-field integration
 * (server/utils/commit-fields.ts) plugs its dirty predicate, field diff and
 * baseline advance into (d)/(b)/(c); OKB-42's block-ID sweep and per-block
 * reindex land in (a)/(c).
 */

export type CommitTrigger = 'manual' | 'disconnect' | 'quiet' | 'max-dirty' | 'agent'

export interface CommitIdentity {
  /** A peer's Drupal session cookie, captured at the auth handshake. Read to
   *  re-verify that session before a checkpoint; never a write carrier. */
  cookie?: string
  /** Agent Bearer token — the one carrier a caller brings (OKB-61). It writes
   *  as the token's owner, capped by the token's scopes; everything else is
   *  carried by the collaboration server. */
  token?: string
  /** Drupal uid of the account acting. Stated to Drupal on a checkpoint the
   *  collaboration server carries, which then writes as them. */
  uid?: number
  /** Account name captured at auth time. For a token this is still the human
   *  account it acts as — an agent token acts as its owner (OKB-58). */
  user?: string
  /** Agent client's label ("Claude") when the carrier is an agent token —
   *  what separates "fago" from "fago via Claude" in the revision log. */
  via?: string
}

/**
 * One name a revision log prints: the account, and the agent client's label
 * when the writing came in through an agent.
 */
export interface CoAuthor {
  name: string
  /** Agent client's label ("Claude"); null for someone writing in a seat. */
  via: string | null
}

/**
 * A checkpoint's statement about itself: a shared session's write, who is
 * acting, and who wrote which part.
 *
 * Stated over the collaboration server's own connection and nowhere else,
 * since both the acting account and contributorship decide what the write may
 * do (ADR 0001). It is part of the write, not a second one, so credit cannot
 * fail separately.
 */
export interface SessionWrite {
  /** The human this write is performed as — the peer who saved, or the
   *  session's majority editor of the dirty window when nobody did. Drupal
   *  becomes them, so their own rights decide what the write may do. Null
   *  leaves it on the carrier's account. */
  actingUid: number | null
  /** Everyone whose writing this checkpoint carries, for the revision log.
   *  Measured over the same window as {@link blocks}, so the names and the text
   *  are one statement taken at one instant. */
  coAuthors: CoAuthor[]
  /** Block id => its writer set `[{uid, via}]` — membership only, for the window
   *  this write carries (ADR 0002). `via` raises the agent step; no amounts are
   *  carried. Exhaustive: every block the session changed is named, so a
   *  changed block missing from it is text this write cannot account for. */
  blocks: Record<string, Array<{ uid: number, via: string | null }>>
  /** The sign-offs peers made during this window, each under the uid of the
   *  connection it arrived on. Drupal decides what each one may record and
   *  answers per action; a refusal never refuses the commit. */
  actions: Array<{ item: string, step: ReviewStep, uid: number }>
}

/** The auth carrier of a commit — a Bearer token, this server's or an agent's. */
export function identityAuthHeaders(identity: CommitIdentity): Record<string, string> {
  return identity.token ? { Authorization: `Bearer ${identity.token}` } : {}
}

export type ProseMirrorJSON = Record<string, unknown>

export interface CommitContext {
  docName: string
  nid: number
  trigger: CommitTrigger
  identity: CommitIdentity
  /** The live document — extenders diff their own lanes (e.g. the `fields`
   *  Y.Map against `_meta.fields_baseline`) directly from it. */
  doc: Y.Doc
  /** This checkpoint's window statement. A seam that changes the payload's
   *  block ids (the OKB-42 sweep) must REPLACE the map here so it stays true
   *  of the payload — never the ledger's own window, which the discharge
   *  subtracts from and stays keyed on the live document's ids. */
  sessionWrite?: SessionWrite
}

/**
 * (e) synchronous document reads — every lane's view of what this revision
 * carries, taken with the body and before the commit's first await. A lane that
 * reads the live document later would answer for a document a concurrent writer
 * has since moved, and the revision would carry two actors' work under one
 * name. Must not await, and must not write to the document.
 */
export type CaptureHook = (ctx: CommitContext) => void
/** (a) pre-serialize doc transforms — OKB-42 block-ID sweep/dedup lands here. */
export type PreSerializeTransform = (json: ProseMirrorJSON, ctx: CommitContext) => ProseMirrorJSON
/** (b) payload extenders — the OKB-48 field diff (attributes+relationships).
 *  May be async (ref resolution talks to Drupal); a {@link CommitValidationError}
 *  thrown here blocks the commit as `invalid` with per-field errors. */
export type PayloadExtender = (extra: KbPagePatchExtra, ctx: CommitContext) => KbPagePatchExtra | Promise<KbPagePatchExtra>
/** (c) post-commit — baseline advances (OKB-48 `fields_baseline`), OKB-42
 *  per-block hash/reindex trigger. */
export type PostCommitHook = (result: CommitResult, ctx: CommitContext) => void | Promise<void>
/** (d) extra dirty predicates — a doc whose body carries nothing new still
 *  commits when any of these returns true (fields join the dirty-check
 *  identity). May be async; asked only on a path about to answer "nothing to
 *  do", and at most once per commit. */
export type DirtyCheck = (ctx: CommitContext) => boolean | Promise<boolean>

export interface CommitHooks {
  captures: CaptureHook[]
  preSerialize: PreSerializeTransform[]
  payloadExtenders: PayloadExtender[]
  postCommit: PostCommitHook[]
  dirtyChecks: DirtyCheck[]
}

/**
 * Concatenates several hook sets into one — the composition point for
 * independent extensions (entity fields, block provenance) that each own a
 * lane of the same commit. Order is preserved per seam, so an earlier set's
 * preSerialize/payloadExtender runs before a later one's.
 */
export function mergeCommitHooks(...sets: Array<Partial<CommitHooks>>): CommitHooks {
  return {
    captures: sets.flatMap(s => s.captures ?? []),
    preSerialize: sets.flatMap(s => s.preSerialize ?? []),
    payloadExtenders: sets.flatMap(s => s.payloadExtenders ?? []),
    postCommit: sets.flatMap(s => s.postCommit ?? []),
    dirtyChecks: sets.flatMap(s => s.dirtyChecks ?? []),
  }
}

/**
 * Thrown by a payload extender to block the commit on invalid values — e.g. an
 * entity reference whose target does not resolve. Carries per-field messages
 * keyed by JSON:API field name (`title`, `field_tags`, …), the same key space
 * the 422 violation mapping produces, so `_meta.commit_error.fields` has one
 * shape regardless of which side rejected the payload.
 */
export class CommitValidationError extends Error {
  readonly fields: Record<string, string[]>
  constructor(message: string, fields: Record<string, string[]> = {}) {
    super(message)
    this.name = 'CommitValidationError'
    this.fields = fields
  }
}

/**
 * Drupal 422 violations → per-field messages keyed by JSON:API field name.
 *
 * JSON:API points at the offending member (`/data/attributes/title`,
 * `/data/relationships/field_tags/...`); core validation details prefix the
 * property path (`field_tags.0.target_id: message`). Violations neither carries
 * land under `''` so no message is silently dropped.
 */
export function violationFields(
  violations: Array<{ detail?: string, source?: { pointer?: string } }> | undefined,
): Record<string, string[]> {
  const fields: Record<string, string[]> = {}
  for (const violation of violations ?? []) {
    const pointer = violation.source?.pointer ?? ''
    const detail = violation.detail ?? ''
    const fromPointer = /^\/data\/(?:attributes|relationships)\/([^/]+)/.exec(pointer)?.[1]
    const fromDetail = /^([a-z0-9_]+(?:\.[a-z0-9_]+)*):\s*(.+)$/is.exec(detail)
    const name = fromPointer ?? fromDetail?.[1]?.split('.')[0] ?? ''
    const message = fromDetail?.[2] ?? detail
    if (!message) continue
    ;(fields[name] ??= []).push(message)
  }
  return fields
}

export type CommitOutcome =
  | 'committed' // wrote a Drupal revision
  | 'clean' // dirty check: nothing changed since last commit
  | 'no-document' // document not loaded in memory
  | 'no-credentials' // no carrier — this server holds no Drupal credential
  | 'unauthenticated' // the captured session no longer answers to Drupal
  | 'conflict' // 409 — Drupal moved underneath the session
  | 'invalid' // 422 — Drupal rejected the payload
  | 'empty-body' // document holds nothing while Drupal holds a page
  | 'error' // anything else

export interface CommitResult {
  outcome: CommitOutcome
  committed: boolean
  markdown?: string
  hash?: string
  changed?: number
  /** On `conflict`: the session's last-known `changed` (what we expected). */
  expected?: number
  /** Drupal already stores exactly what this commit was going to write —
   *  a write DID land (lost response, or an agent's), unlike plain `clean`.
   *  Its accounting counts as delivered; stating it again would double-book
   *  and measure undo against bytes Drupal no longer holds. */
  adopted?: boolean
  /** On `error`: the status Drupal answered with, when it answered at all. */
  status?: number
  message?: string
  /** On `invalid`: per-field messages keyed by JSON:API field name. */
  fields?: Record<string, string[]>
  /** On `committed`: Drupal's answer to the sign-offs this checkpoint stated. */
  review?: ReviewOutcome
}

/** One name as the log prints it — "fago", or "fago via Claude". */
function coAuthorLabel(peer: CoAuthor): string {
  return actorLabel(peer.name, peer.via)
}

/** The carrier as a one-name window, for a commit that states none. */
function carrierCoAuthors(identity: CommitIdentity): CoAuthor[] {
  return identity.user && identity.via ? [{ name: identity.user, via: identity.via }] : []
}

/**
 * Revision log message written with every commit.
 *
 * Two things Drupal cannot otherwise tell an editor reading the revision list.
 * First, *which path* produced the revision — a `disconnect`/`quiet`/
 * `max-dirty` checkpoint has no human behind the write at all. Second, that an
 * agent wrote it: an agent commit's `revision_uid` is the token's *owner*, so
 * the log line is the only place the agent appears.
 *
 * The names come from the checkpoint's own window, which is measured over the
 * text this revision carries. The carrier is not consulted while a window
 * exists: it authorizes the write, and on a document somebody else opened it
 * names them rather than the writer. A commit that states no window at all (no
 * collaboration secret) has only the carrier to go on.
 */
export function revisionLog(ctx: CommitContext, session?: SessionWrite): string {
  const stated = session ? session.coAuthors : carrierCoAuthors(ctx.identity)
  // One name adds nothing to a revision `revision_uid` already attributes to
  // that person — unless it is an agent, which `revision_uid` cannot show at
  // all. On a shared session one name is a fraction of the answer, so the
  // others are named here, where a revision list can show them.
  const named = stated.length > 1 || stated.some(peer => peer.via) ? stated : []
  const suffix = named.length > 0 ? ` — ${named.map(coAuthorLabel).join(', ')}` : ''
  return `OpenKB commit (${ctx.trigger})${suffix}`
}

/** sha256 of the serialized markdown — the dirty-check identity. */
export function contentHash(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex')
}

/**
 * Y.Doc `default` fragment → comark markdown, through the shared schema and
 * serializer. Pure and DOM-free; unit-tested directly over seeded Y.Docs.
 */
export function serializeYDoc(
  doc: Y.Doc,
  preSerialize: PreSerializeTransform[] = [],
  ctx?: CommitContext,
): string {
  return serializeCommitJSON(yDocToProsemirrorJSON(doc, 'default') as ProseMirrorJSON, preSerialize, ctx)
}

/**
 * The markdown a commit writes for a document tree — the transforms, the schema
 * and the serializer a checkpoint would use, over a tree from anywhere.
 *
 * Its other caller asks what a commit *would* write for markdown Drupal already
 * stores, which is what makes the dirty check answer a question about content
 * rather than about spelling. Comark's serializer has one canonical output
 * style, so `_em_`, `* item`, a setext heading or a padded table all come back
 * spelled differently — a hash taken over Drupal's own bytes therefore reports
 * every legacy page as dirty from the moment it loads, and a session that
 * typed nothing writes a revision canonicalizing the whole body. Every drifted
 * block then reaches presave as changed with nothing accounting for it, which is
 * the review state reserved for text no server witnessed.
 */
export function serializeCommitJSON(
  json: ProseMirrorJSON,
  preSerialize: PreSerializeTransform[] = [],
  ctx?: CommitContext,
): string {
  for (const transform of preSerialize) json = transform(json, ctx as CommitContext)
  return serializeDocToMarkdown(PMNode.fromJSON(editorSchema, json))
}

export interface CommitOptions {
  trigger: CommitTrigger
  identity?: CommitIdentity
  /** The pipeline seams; every one an extension does not fill stays empty. */
  hooks?: Partial<CommitHooks>
  /** Injectable clock for deterministic tests. */
  now?: () => number
  /** Injectable pause, same purpose. */
  wait?: (ms: number) => Promise<void>
  /**
   * Asked after the document is in hand and found dirty, before the write: may
   * this commit still happen? `true` proceeds; any other value is the outcome
   * the commit returns instead of writing.
   *
   * The collab server uses it to re-verify the session it captured — a
   * checkpoint is where keystrokes become durable facts, and those must not be
   * written under a credential that has since been logged out or revoked.
   * Asking here rather than before the call keeps the document reference the
   * commit already holds: the last peer leaving unloads the document within
   * the round trip, and a check that ran first would hand its own edits to a
   * `no-document` outcome.
   *
   * It returns an outcome rather than a boolean because the reasons differ in
   * kind: a session Drupal has refused is `unauthenticated` and is final, while
   * a Drupal that could not be reached is a transient `error` — same skipped
   * write, but only the first may cost anyone their socket. That difference is
   * also why a `disconnect` commit asks again on `error`: see
   * {@link TERMINAL_PRECONDITION_TRIES}.
   */
  precondition?: () => Promise<true | CommitOutcome>
  /**
   * Present when this commit is a collaborative session's checkpoint rather
   * than one account's save. See {@link SessionWrite}.
   */
  sessionWrite?: SessionWrite
}

/**
 * How many times a `disconnect` commit asks its precondition while the answer
 * is `error` — Drupal unreachable, as opposed to Drupal refusing.
 *
 * That trigger is terminal: the last peer has left and the document unloads
 * behind this commit, so there is no later checkpoint to ask again and a single
 * miss costs the session its final revision. Bounded, because the wait holds an
 * unloading document open. Every other trigger asks once; the next one asks
 * again.
 */
export const TERMINAL_PRECONDITION_TRIES = 3
const TERMINAL_PRECONDITION_WAIT_MS = 250

/**
 * Whether any dirty predicate claims this commit. Asked in order and stops at
 * the first that says yes, so a costly predicate behind a cheap one is skipped.
 */
async function anyDirtyCheck(checks: DirtyCheck[], ctx: CommitContext): Promise<boolean> {
  for (const check of checks) {
    if (await check(ctx)) return true
  }
  return false
}

/**
 * Commit one document. Idempotent: an unchanged doc (hash matches
 * _meta.last_commit_hash) writes zero revisions regardless of trigger.
 */
export async function commitDocument(
  hp: Pick<Hocuspocus, 'documents'>,
  docName: string,
  options: CommitOptions,
): Promise<CommitResult> {
  const now = options.now ?? (() => Date.now())
  const hooks: CommitHooks = mergeCommitHooks(options.hooks ?? {})

  const match = /^node:(\d+)$/.exec(docName)
  if (!match) return { outcome: 'error', committed: false, message: `invalid document name: ${docName}` }
  const nid = Number(match[1])

  const doc = hp.documents.get(docName) as unknown as Y.Doc | undefined
  if (!doc) return { outcome: 'no-document', committed: false }

  const identity = options.identity ?? {}
  const ctx: CommitContext = {
    docName,
    nid,
    trigger: options.trigger,
    identity,
    doc,
    ...(options.sessionWrite ? { sessionWrite: options.sessionWrite } : {}),
  }

  // One instant, one revision. Each lane's read here, the body just below, and
  // nothing awaited between them. Ops landing while the commit is in flight
  // belong to the next revision, under their own writer's name; a lane reading
  // the document after an await would mix them into this one.
  for (const capture of hooks.captures) capture(ctx)
  const markdown = serializeYDoc(doc, hooks.preSerialize, ctx)
  const hash = contentHash(markdown)

  const meta = doc.getMap('_meta')
  const lastHash = meta.get('last_commit_hash') as string | undefined
  // A reason to write the body does not carry, asked at most once. Every exit
  // below that would answer "nothing to do" has to consult it.
  let claim: Promise<boolean> | null = null
  const claimed = (): Promise<boolean> => (claim ??= anyDirtyCheck(hooks.dirtyChecks, ctx))
  // Clean only when the body hash matches AND no extra dirty predicate fires —
  // a field-only change must commit, an unchanged doc+fields must not.
  if (lastHash && lastHash === hash && !(await claimed())) {
    return { outcome: 'clean', committed: false, markdown, hash }
  }

  if (options.precondition) {
    const tries = options.trigger === 'disconnect' ? TERMINAL_PRECONDITION_TRIES : 1
    const wait = options.wait ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
    let verdict = await options.precondition()
    // Only `error` is worth asking twice — every other verdict is an answer.
    for (let n = 1; n < tries && verdict === 'error'; n++) {
      await wait(TERMINAL_PRECONDITION_WAIT_MS)
      verdict = await options.precondition()
    }
    if (verdict !== true) return { outcome: verdict, committed: false, markdown, hash }
  }

  const auth = identityAuthHeaders(identity)
  if (Object.keys(auth).length === 0) {
    // No token to write with: the collaboration server's consumer is
    // unprovisioned, or an agent handed over nothing.
    return { outcome: 'no-credentials', committed: false, markdown, hash }
  }

  try {
    // The working copy, not the published default: every checkpoint writes a
    // forward draft on a moderated page, so the revision this session last
    // wrote — the one `_meta.drupal_changed` tracks — is the working copy. On
    // the published default the concurrency check below would see its own
    // draft as an external change and wedge the session at the second
    // checkpoint. Both auth carriers need it: an agent's bearer-authenticated
    // checkpoint drafts exactly like an editor's cookie session.
    const { page } = await fetchCeWorkingCopy(auth, nid)

    // A document that serializes to nothing while Drupal holds a page is
    // not a deletion — it is a document caught mid-flight: loaded from the
    // snapshot store before the first client hydrated its fragment, or between
    // a session-less reconcile clearing the fragment and re-filling it. A
    // disconnect checkpoint is immediate and lands in exactly that window.
    //
    // Committing it cannot succeed (`field_kb_body` is required, so Drupal
    // answers 422 "This value should not be null") and the failure is not
    // harmless: `drupal_changed` never advances, so the session is left looking
    // like it never checkpointed. Skipping leaves the document, Drupal and the
    // baselines untouched — the next checkpoint, once a peer has hydrated,
    // writes the real content.
    //
    // An editor genuinely emptying a page is unaffected: that write is
    // rejected by the same required-field constraint whether it is sent or not.
    if (markdown.trim() === '' && (page.body ?? '').trim() !== '') {
      console.warn(`[collab] ${docName}: ${ctx.trigger} checkpoint skipped — document is empty, Drupal is not`)
      return { outcome: 'empty-body', committed: false, markdown, hash, changed: page.changed }
    }

    // Extenders run before the concurrency verdict so the adopt branch below
    // can tell "nothing at all to write" from "body adopted, fields pending".
    // A CommitValidationError from an extender (unresolvable ref, bad value)
    // surfaces through the catch as `invalid` with its per-field messages.
    let extra: KbPagePatchExtra = {}
    for (const extend of hooks.payloadExtenders) extra = await extend(extra, ctx)
    const extraHasContent
      = Object.keys(extra.attributes ?? {}).length > 0
        || Object.keys(extra.relationships ?? {}).length > 0

    // Optimistic concurrency, first pass: if Drupal moved since the session's
    // last-known `changed`, do not overwrite — flag the external change so
    // every peer shows the reload banner.
    //
    // This pass exists for the adopt branch below and to save a round trip; it
    // is not the guarantee. The comparison is client-side (find → compare →
    // write), so a write landing between the find and the commit passes it.
    // The token rides the payload as `based_on_changed` and Drupal refuses a
    // stale one with 409, inside the lock that orders the writers.
    const expected = Number(meta.get('drupal_changed') ?? 0)
    if (expected > 0 && page.changed !== expected) {
      if (page.body === markdown) {
        // Drupal moved, but to exactly what this session holds — a lost `_meta`
        // write, or the user reverted onto the external revision. Adopt the
        // baseline so the session is not wedged behind a conflict it can never
        // resolve. The adopted baseline then unblocks the PATCH for anything
        // this commit still owes: an extender payload (a field-only change),
        // or a dirty claim the body does not carry (an explicit Save). Fall
        // through and write it.
        Y.transact(doc, () => {
          meta.set('drupal_changed', page.changed)
          meta.set('last_commit_hash', hash)
          meta.delete('external_change_detected')
        })
        if (!extraHasContent && !(await claimed())) {
          return { outcome: 'clean', committed: false, adopted: true, markdown, hash, changed: page.changed }
        }
      }
      else {
        Y.transact(doc, () => {
          meta.set('external_change_detected', { actual: page.changed, at: now() })
        })
        return { outcome: 'conflict', committed: false, markdown, hash, changed: page.changed, expected }
      }
    }
    // Trigger + identity on the revision itself, so Drupal's revision log tells
    // an editor which of the four commit paths wrote it without correlating
    // timestamps against the frontend log. Merged after the extenders and
    // under them, so an extender can still override it deliberately.
    extra = {
      ...extra,
      // The revision this payload was assembled against, for Drupal's own
      // conditional write. `page.changed`, not `expected`: it is the value
      // the body above was compared with, and the adopt branch has just moved
      // `expected` onto it.
      basedOnChanged: page.changed,
      attributes: {
        revision_log: revisionLog(ctx, options.sessionWrite),
        ...(extra.attributes ?? {}),
      },
      // From the context, not the options: a pre-serialize seam may have
      // rewritten the map to follow a block whose id it re-minted.
      ...(ctx.sessionWrite
        ? {
            session: {
              acting_uid: ctx.sessionWrite.actingUid,
              blocks: ctx.sessionWrite.blocks,
              actions: ctx.sessionWrite.actions,
            },
          }
        : {}),
    }

    // The title heading and the final newline belong to the stored body, not
    // to the document (server/utils/title-heading.ts). The heading is spelt
    // from the title this write leaves behind, so a rename carries it.
    const stored = storedBody(page.titleHeading, extra.attributes?.title ?? page.title, markdown)
    const { changed, review } = await commitKbPageWithAuth(auth, nid, stored, extra)

    const at = now()
    Y.transact(doc, () => {
      meta.set('drupal_changed', changed)
      meta.set('last_save_at', at)
      meta.set('last_commit_hash', hash)
      meta.delete('external_change_detected')
      meta.delete('commit_error')
      // Drupal's answer to the sign-offs this checkpoint carried, for whoever
      // made them. Dropped where it carried none, so yesterday's refusal does
      // not re-surface on today's save.
      if (review) meta.set('review', { at, ...review })
      else meta.delete('review')
    })

    const result: CommitResult = {
      outcome: 'committed',
      committed: true,
      markdown,
      hash,
      changed,
      ...(review ? { review } : {}),
    }

    // Lane bookkeeping (fields baseline, provenance baseline) writes to the
    // doc, so it must land BEFORE the confirmed-checkpoint signal below. A peer
    // clears its y-indexeddb mirror the moment it sees `last_commit` advance
    // and re-creates it on the next doc update — a lane write arriving after
    // the signal would immediately resurrect the mirror it just cleared.
    //
    // The PATCH has already succeeded at this point, so a failing hook must
    // not cost the session its checkpoint signal: log and carry on.
    for (const hook of hooks.postCommit) {
      try {
        await hook(result, ctx)
      }
      catch (hookErr) {
        console.error(`[commit] ${ctx.docName}: post-commit hook failed after a successful PATCH`, hookErr)
      }
    }

    // Confirmed-checkpoint signal, and the last doc write of a commit. Peers
    // observe `last_commit.at` to clear their y-indexeddb mirror (SAL-324
    // §10.8) and advance the history chip.
    Y.transact(doc, () => {
      meta.set('last_commit', { at, changed, hash, trigger: options.trigger })
    })
    return result
  }
  catch (err) {
    // Extender-side rejection (unresolvable ref, bad value): the payload never
    // reached Drupal; the per-field messages come straight from the extender.
    if (err instanceof CommitValidationError) {
      Y.transact(doc, () => {
        meta.set('commit_error', {
          at: now(),
          kind: 'validation',
          message: err.message,
          fields: err.fields,
          trigger: options.trigger,
        })
      })
      return { outcome: 'invalid', committed: false, markdown, hash, message: err.message, fields: err.fields }
    }

    const e = err as {
      statusCode?: number
      data?: {
        drupalStatus?: number
        violations?: Array<{ detail?: string, source?: { pointer?: string } }>
        conflict?: { expected: number, actual: number }
      }
      message?: string
    }
    const status = e?.data?.drupalStatus ?? e?.statusCode
    if (status === 409 && e?.data?.conflict) {
      // Drupal refused the write: somebody landed a revision between this
      // session's read and its commit. Same peer-visible state the first-pass
      // check raises, so every peer gets the one reload banner.
      const { expected: base, actual } = e.data.conflict
      Y.transact(doc, () => {
        meta.set('external_change_detected', { actual, at: now() })
      })
      return { outcome: 'conflict', committed: false, markdown, hash, changed: actual, expected: base }
    }
    if (status === 422) {
      const message = e?.message ?? 'Validation failed'
      const fields = violationFields(e?.data?.violations)
      // Stateless-ish surface: a peer-visible error, not a state reset. The
      // per-field map (JSON:API field names) feeds the FrontmatterForm slots.
      Y.transact(doc, () => {
        meta.set('commit_error', { at: now(), kind: 'validation', message, fields, trigger: options.trigger })
      })
      return { outcome: 'invalid', committed: false, markdown, hash, message, fields }
    }
    return { outcome: 'error', committed: false, markdown, hash, status, message: e?.message ?? String(err) }
  }
}
