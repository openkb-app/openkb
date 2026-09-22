import * as Y from 'yjs'
import { prosemirrorToYXmlFragment } from '@tiptap/y-tiptap'
import { contentHash, serializeCommitJSON, serializeYDoc, type ProseMirrorJSON } from './commit'
import { parseMarkdownToDoc } from '../../app/comark/markdown-engine'
import { type FieldValues } from './entity-fields'
import { parseBlockMeta, writeBlockMeta } from '#shared/page-blocks'
import { META_DELETED_AT, deletedAtOf } from '#shared/utils/collab-meta'
import { seedComments, type StoredConversations } from './collab-comments'

/**
 * Session-less reconcile of a collaborative document against Drupal.
 *
 * Seeding hierarchy: live peers > hot Y.Doc > Drupal. Drupal wins only when no
 * session is live — so a revision written while nobody was editing (agent,
 * JSON:API, another tab) is never shadowed by a stale hot document. The plugin
 * reaches this from two directions, because "no live session" and "not in
 * memory" are different states: onLoadDocument (loading from SQLite) and
 * onAuthenticate (still in memory, zero connections).
 *
 * Divergence is decided on `changed` OR the body hash, never on `changed`
 * alone: Drupal's `changed` is second-granular, so a checkpoint and an
 * external write in the same second look identical by time.
 *
 * Edits are not lost to the reset: the callers reconcile only after the
 * document's checkpoints have settled (CheckpointScheduler.waitIdle), so
 * anything a session left behind already has its Drupal revision, and a
 * document Drupal has not moved under keeps its fragment. A hot document that
 * already matches Drupal's body is adopted rather than reset, so a checkpoint
 * whose `_meta` write was lost never costs a re-hydration.
 *
 * A reset replaces the fragment's content with Drupal's, in one transaction —
 * it never leaves the document empty, not even briefly. The document is always
 * committable: whatever a checkpoint racing the reset serializes is either the
 * old content or Drupal's, never nothing.
 *
 * The `fields` Y.Map rides along on every reconcile (see {@link seedFields}),
 * as do the sidecar and the conversations (see {@link seedComments}): same
 * hierarchy, no adopt/reset distinction, because re-seeding one of those is a
 * `set` rather than a re-hydration. The returned outcome describes the body.
 */

/**
 * The dirty-check hash for markdown Drupal already stores.
 *
 * NOT a hash of Drupal's bytes — the hash of what a commit WOULD write.
 * Comark canonicalizes markdown (see test/roundtrip/NORMALIZATIONS.md), so a
 * baseline seeded from raw bytes calls every differently-spelled page
 * dirty on load: a visit where nobody typed writes a canonicalizing revision
 * with unaccounted block changes. A body that cannot round-trip falls back
 * to its raw bytes — an over-eager check merely costs a redundant revision.
 */
function storedBodyHash(documentName: string, body: string): string {
  if (body.trim() === '') {
    return contentHash(body)
  }
  try {
    const json = parseMarkdownToDoc(body).toJSON() as ProseMirrorJSON
    return contentHash(serializeCommitJSON(json))
  }
  catch (err) {
    console.warn(`[collab] ${documentName}: body does not round-trip, baselining its bytes`, err)
    return contentHash(body)
  }
}

export type SeedOutcome =
  | 'reset' // fragment rewritten from Drupal's body, atomically
  | 'adopted' // hot doc already equals Drupal's body — baseline advanced
  | 'seeded' // first load: baseline `changed` + hash written
  | 'backfilled' // pre-commit-service snapshot: hash baseline written
  | 'in-sync' // nothing to do
  | 'unavailable' // Drupal did not answer; leave the document untouched

export interface SeedDeps {
  /** Drupal's current `changed` for the node, or null when unreachable. */
  fetchChanged: (nid: number) => Promise<number | null>
  /** Drupal's current markdown body, or null when unreachable. */
  fetchBody: (nid: number) => Promise<string | null>
  /** Drupal's current values for the exposed fields, or null when unreachable. */
  fetchFields?: (nid: number) => Promise<FieldValues | null>
  /** Drupal's stored `field_block_meta` JSON, or null when unreachable/absent. */
  fetchBlockMeta?: (nid: number) => Promise<string | null>
  /** The page's stored conversations, or null when unreachable. */
  fetchComments?: (nid: number) => Promise<StoredConversations | null>
  now?: () => number
}

/**
 * Brings the `fields` Y.Map in line with Drupal.
 *
 * Same hierarchy as the body, one step simpler: this runs only when no
 * session is live, so Drupal wins outright — there are no peer edits to
 * preserve and re-seeding a field costs one `set`, not a re-hydration. Keys
 * are written individually and only when the value actually differs, so the
 * per-key LWW semantics every writer relies on hold here too.
 *
 * `_meta.fields_baseline` records what Drupal held at seed time — what the
 * commit's field diff (OKB-48) measures the session's changes against.
 *
 * `values` carries exactly the keys the current exposure contract addresses
 * (the schema's fields plus the title), so the live map is aligned to that key
 * set: a key a persisted document still holds from a wider contract — a field
 * since taken off the `frontmatter` form display — is dropped. Keeping it
 * would leave the map carrying a key the baseline lacks, which the commit
 * diff reads as a session edit to a field nothing can address.
 */
export function seedFields(document: Y.Doc, values: FieldValues): void {
  const fields = document.getMap('fields')
  const meta = document.getMap('_meta')
  Y.transact(document, () => {
    const stale = [...fields.keys()].filter(key => !(key in values))
    if (stale.length > 0) {
      console.log(`[collab] pruning fields no longer exposed: ${stale.join(', ')}`)
      for (const key of stale) fields.delete(key)
    }
    for (const [key, value] of Object.entries(values)) {
      if (JSON.stringify(fields.get(key) ?? null) !== JSON.stringify(value ?? null)) {
        fields.set(key, value)
      }
    }
    meta.set('fields_baseline', values)
  })
}

/**
 * Brings the `blockMeta` Y.Map in line with Drupal's `field_block_meta`.
 *
 * Drupal wins, whole: the map is aligned to exactly Drupal's entries and every
 * key Drupal does not have is dropped — extras a prior session left behind,
 * and any flag the live mirror estimated ahead of the checkpoint that would
 * earn it (server/utils/collab-sidecar.ts). Malformed stored JSON parses to an
 * empty map rather than throwing.
 *
 * Called on the session-less reconcile, after every checkpoint and on a revert
 * — the three moments Drupal's copy is newer than the session's.
 */
export function seedBlockMeta(document: Y.Doc, raw: string): void {
  Y.transact(document, () => {
    writeBlockMeta(document, parseBlockMeta(raw))
  })
}



/**
 * Reads back the Drupal-side field values the session was seeded with.
 * Absent on documents that predate field seeding.
 */
export function fieldsBaseline(document: Y.Doc): FieldValues | null {
  return (document.getMap('_meta').get('fields_baseline') as FieldValues | undefined) ?? null
}

/**
 * Rewrites a live document's body to `body`, atomically, and moves its
 * coordination state onto the revision that body came from.
 *
 * The other half of a document revert (OKB-84): the Drupal write creates the
 * new draft revision, this makes every connected peer converge on it. Unlike
 * {@link seedFromDrupal} it runs *with peers editing* — that is the point, the
 * whole session is meant to land on the reverted content rather than be told
 * to reload — so it deliberately discards whatever the fragment held. The
 * caller is answerable for that being what the user asked for.
 *
 * `_meta` moves in the same transaction as the content, so no checkpoint can
 * photograph a document whose body and baseline disagree: an untouched
 * document after this is *clean* (hash matches) and its next commit's
 * concurrency check passes against the revision just written.
 *
 * `last_commit` is written last and separately, for the reason the commit
 * service writes it last: peers drop their offline mirror the moment it
 * advances, so no lane may write to the document after it.
 */
export function resetDocumentToBody(
  document: Y.Doc,
  body: string,
  changed: number,
  now: () => number = () => Date.now(),
): void {
  const fragment = document.getXmlFragment('default')
  const meta = document.getMap('_meta')
  const hash = contentHash(body)
  const at = now()
  const seeded = body ? parseMarkdownToDoc(body) : null
  Y.transact(document, () => {
    if (seeded) {
      prosemirrorToYXmlFragment(seeded, fragment)
    }
    else if (fragment.length > 0) {
      fragment.delete(0, fragment.length)
    }
    meta.set('drupal_changed', changed)
    meta.set('last_commit_hash', hash)
    meta.set('last_save_at', at)
    meta.set('reset_at', at)
    meta.delete('external_change_detected')
    meta.delete('commit_error')
  })
  Y.transact(document, () => {
    meta.set('last_commit', { at, changed, hash, trigger: 'revert' })
  })
}

/**
 * Moves a live document's concurrency token onto a revision written beside it
 * — a publish, which changes the page's state and nothing about its body.
 *
 * Without this the session's `_meta.drupal_changed` still names the
 * pre-publish revision, and the next checkpoint reads the publish as an
 * external change and 409s the whole session.
 */
export function advanceDocumentChanged(
  document: Y.Doc,
  changed: number,
  now: () => number = () => Date.now(),
): void {
  const meta = document.getMap('_meta')
  Y.transact(document, () => {
    meta.set('drupal_changed', changed)
    meta.set('last_save_at', now())
    meta.delete('external_change_detected')
  })
}

/** Which of the two session-less entry points asked for the reconcile. */
export type SeedOrigin = 'load' | 'idle'

export async function seedFromDrupal(
  documentName: string,
  document: Y.Doc,
  deps: SeedDeps,
  origin: SeedOrigin = 'load',
): Promise<SeedOutcome> {
  const match = /^node:(\d+)$/.exec(documentName)
  if (!match) return 'unavailable'
  const nid = Number(match[1])

  // The lanes are independent: an unreachable schema must not stop the body
  // from reconciling, and a body outcome of 'unavailable' says nothing about
  // the fields or the provenance sidecar. All requests go out together.
  const fieldsPending = deps.fetchFields?.(nid) ?? Promise.resolve(null)
  const blockMetaPending = deps.fetchBlockMeta?.(nid) ?? Promise.resolve(null)
  const commentsPending = deps.fetchComments?.(nid) ?? Promise.resolve(null)
  const outcome = await seedBodyFromDrupal(documentName, document, deps, origin, nid)
  const values = await fieldsPending
  if (values !== null) seedFields(document, values)
  const blockMeta = await blockMetaPending
  if (blockMeta !== null) seedBlockMeta(document, blockMeta)
  const conversations = await commentsPending
  if (conversations !== null
    && seedComments(document, conversations.uuid, conversations.messages) === 'dropped') {
    console.log(
      `[collab] ${documentName}: conversations dropped — the id now belongs to ${conversations.uuid}`,
    )
  }
  return outcome
}

async function seedBodyFromDrupal(
  documentName: string,
  document: Y.Doc,
  deps: SeedDeps,
  origin: SeedOrigin,
  nid: number,
): Promise<SeedOutcome> {
  const now = deps.now ?? (() => Date.now())

  const drupalChanged = await deps.fetchChanged(nid)
  if (drupalChanged === null) return 'unavailable'

  const meta = document.getMap('_meta')

  // Drupal answered about this node, so it exists — and a document whose node
  // exists is not a deleted one. The stamp a delete leaves behind
  // (server/utils/collab-control.ts) outlives the node in the snapshot store,
  // which is keyed by node id and survives the node it describes; a document
  // name that comes round again would otherwise hand the tombstone to the new
  // node's first peer, whose editor then closes itself on a deletion that is
  // not its own. Reconciling it away here is the same contract as the rest of
  // this function: what Drupal says wins.
  if (deletedAtOf(meta)) {
    console.log(`[collab] ${documentName}: clearing a deletion stamp — the node exists`)
    Y.transact(document, () => { meta.delete(META_DELETED_AT) })
  }

  const lastSeen = Number(meta.get('drupal_changed') ?? 0)

  // First load: seed the dirty-check baseline from Drupal's canonical body.
  // The client hydrates the fragment from that same body, so an untouched
  // session serializes back to an equal hash and checkpoints write nothing.
  if (!lastSeen) {
    const body = await deps.fetchBody(nid)
    meta.set('drupal_changed', drupalChanged)
    if (body !== null) meta.set('last_commit_hash', storedBodyHash(documentName, body))
    return 'seeded'
  }

  const lastHash = meta.get('last_commit_hash') as string | undefined
  const body = await deps.fetchBody(nid)
  if (body === null) return 'unavailable'
  const bodyHash = storedBodyHash(documentName, body)

  // Two independent tells that Drupal holds something this document has not
  // seen. The timestamp alone is not enough: Drupal's `changed` has one-second
  // granularity, so a checkpoint and an external write landing in the same
  // second are indistinguishable by time — the body hash still catches it.
  const diverged = drupalChanged > lastSeen || (lastHash !== undefined && bodyHash !== lastHash)
  if (!diverged) {
    if (lastHash === undefined) {
      // Snapshot predating the commit service — backfill the baseline once.
      meta.set('last_commit_hash', bodyHash)
      return 'backfilled'
    }
    return 'in-sync'
  }

  const fragment = document.getXmlFragment('default')

  // The hot document already says what Drupal says — a checkpoint whose
  // `_meta` write was lost to an unload, or a client-side revert onto the
  // external revision. Nothing to reset: adopt the baseline, which also
  // unblocks the next commit's concurrency check.
  // Both sides are what a commit would write — the doc through the serializer,
  // Drupal's body through {@link storedBodyHash} — so the question is whether
  // the content agrees, not whether it is spelled the same way.
  if (fragment.length > 0 && contentHash(serializeYDoc(document)) === bodyHash) {
    Y.transact(document, () => {
      meta.set('drupal_changed', drupalChanged)
      meta.set('last_commit_hash', bodyHash)
      meta.delete('external_change_detected')
    })
    return 'adopted'
  }

  console.log(
    `[collab] ${documentName}: Drupal moved between sessions `
    + `(changed ${lastSeen} → ${drupalChanged}), resetting (${origin})`,
  )
  // Write Drupal's content into the fragment in the same transaction that
  // drops the stale one. Clearing it and leaving the re-hydration to whichever
  // client connects next opens a window in which the document *is* empty, and
  // a checkpoint firing into that window (a disconnect checkpoint is
  // immediate) photographs it: the commit serializes an empty body and either
  // 422s on the required body field or writes the emptiness into Drupal.
  // Parsing here uses the same comark engine the client hydrates with, so the
  // fragment is byte-identical to what the client would have produced — and
  // the client's hydration guard (fragment empty) then correctly skips.
  const seeded = body ? parseMarkdownToDoc(body) : null
  Y.transact(document, () => {
    if (seeded) {
      prosemirrorToYXmlFragment(seeded, fragment)
    }
    else if (fragment.length > 0) {
      fragment.delete(0, fragment.length)
    }
    meta.set('drupal_changed', drupalChanged)
    meta.set('reset_at', now())
    meta.set('last_commit_hash', bodyHash)
    meta.delete('external_change_detected')
  })
  return 'reset'
}
