import * as Y from 'yjs'
import type { JSONContent } from '@tiptap/core'

/**
 * The page seen as the blocks it is made of — one model, both sides.
 *
 * A page is a sequence of top-level blocks, each carrying a stable id, and
 * a sidecar (`field_block_meta`) holding what is known about each: who wrote
 * it, and what review it still owes. This module is that model for the
 * frontend — the id codec, the sidecar shapes, the read-time projections, and
 * the Y.Doc layer the live session keeps it in.
 *
 * Drupal mirrors the same key names in `\Drupal\openkb_workflow\PageBlocks`.
 * The two never share code — one side speaks ProseMirror and the other reads
 * raw markdown segments — but they read and write the same stored JSON, so the
 * names are the contract.
 *
 * ## Who writes it
 *
 * Nobody here. Every value in the sidecar is a fact a server witnessed: a
 * contributor entry comes from diffing what a request actually changed, an
 * approval from the account the collaboration server authenticated. The
 * field is write-dead to clients on every path. What this module does on the
 * client is *read* — project the sidecar into chips, bylines and blocker
 * lists.
 *
 * ## The review steps
 *
 * Two, and they answer different questions. `peer` asks whether somebody other
 * than the author has read the change; `agent` asks whether a human has read
 * what a machine wrote. A `pending:<step>` key present IS the flag — there is
 * nothing to derive, no fingerprint to compare, and content moving under a
 * sign-off is not something anybody has to notice after the fact, because the
 * write that moved it re-stamped the flag.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Who an edit is attributed to. `via: null` is a direct human edit; a non-null
 * `via` (e.g. "Claude") is the owner acting through an agent.
 */
export interface Actor {
  uid: number | null
  via: string | null
}

/** One contributor of a block. Membership, not volume (ADR 0002). */
export interface Contributor extends Actor {
  /** Display name captured at edit time (read-page byline convenience). */
  name?: string | null
  /** Wall-clock ms of this actor's last contribution to the block. */
  lastEdit: number
}

/** True when two entries are the same acting identity. */
export function isSameActor(a: Actor, b: Actor): boolean {
  return (a.uid ?? null) === (b.uid ?? null) && (a.via ?? null) === (b.via ?? null)
}

/**
 * The stable string identity of `{uid, via}` — the key one contributor's entry
 * is held under, both in the Y.Doc and in the canonical serialization. JSON so
 * that no uid/via value can forge another actor's key by containing the
 * separator.
 */
export function contributorKey(actor: Actor): string {
  return JSON.stringify([actor.uid ?? null, actor.via ?? null])
}


// ---------------------------------------------------------------------------
// Review steps
// ---------------------------------------------------------------------------

/** The two review steps a block can owe. */
export type ReviewStep = 'peer' | 'agent'

/**
 * Both steps, in the order every ordered surface names them.
 *
 * Agent first because that is the order a block is reviewed in: a human reads
 * what the agent wrote and clears that step, and the block then stands as that
 * human's writing, still owing an independent peer.
 */
export const REVIEW_STEPS: readonly ReviewStep[] = ['agent', 'peer']

/** A recorded sign-off: who, when, and which revision they were looking at. */
export interface Approval {
  uid: number | null
  name?: string | null
  /** Server time of the sign-off, in seconds — Drupal's request time. */
  at: number
  /** The revision id the sign-off was given against. */
  vid: number
  /**
   * The four-eyes baseline this sign-off settled — the accounts whose writing
   * it covered.
   *
   * Kept because a settled step can be re-opened over the SAME text, by a write
   * that names one of its own approvers as a writer of it. What re-opens has to
   * ask for eyes that did not write the block, and that means every writer the
   * settled episode knew about, not only the ones the re-opening write names.
   * Nothing else records them: the pending entry is unset the moment the step
   * settles, and the contributor list is cumulative across every episode the
   * block has ever had.
   */
  by?: number[]
}

/**
 * A step that is still waiting.
 *
 * `by` are the accounts whose changes it is waiting on — its four-eyes
 * baseline — and `ok` the approvals collected against that same episode. An
 * edit landing on the block resets `ok`: those approvals were given to text
 * that has since moved.
 */
export interface PendingStep {
  by: number[]
  ok: Approval[]
  /**
   * Set on a flag the collaboration server mirrored ahead of the checkpoint
   * that earns it, so the mark follows the edit (`server/utils/collab-sidecar.ts`).
   * Drupal never writes the key, so its absence means witnessed, and the mirror
   * reads it to tell its own flags from Drupal's. It changes nothing about how
   * the flag is drawn or signed off.
   */
  estimated?: boolean
}

/**
 * The sidecar entry the page's title is reviewed under.
 *
 * A review item need not be a block. The title carries no block of its own —
 * the frontend splits its markdown heading off at the read boundary
 * (`server/utils/title-heading.ts`) — and a removed block has no text left to
 * hang a flag on, so both take an entry beside the blocks: a removed block
 * keeps its own id, marked `deleted`, and the title takes this key. A block id
 * is `[\w-]+`, so the colon keeps the two namespaces apart.
 *
 * `\Drupal\openkb_workflow\PageBlocks::FIELD_TITLE` is the same string.
 */
export const TITLE_REVIEW_KEY = 'field:title'

/** The sidecar key a step's pending flag is held under. */
export function pendingKey(step: ReviewStep): string {
  return `pending:${step}`
}

/** The sidecar key a step's latest completed sign-off is held under. */
export function reviewKey(step: ReviewStep): string {
  return `review:${step}`
}

// ---------------------------------------------------------------------------
// One block
// ---------------------------------------------------------------------------

/** Everything the sidecar holds for one block. */
export interface PageBlock {
  /** Absent on a block Drupal stamped unaccounted — nobody is recorded. */
  contributors?: Contributor[]
  /** Set where the draft holds the block in a place the live page does not. */
  moved?: boolean
  /** Present while the step is pending — the flag itself. */
  'pending:peer'?: PendingStep
  'pending:agent'?: PendingStep
  /** The latest completed sign-off. Byline data; it gates nothing. */
  'review:peer'?: Approval
  'review:agent'?: Approval
}

/** The whole sidecar: block id → what is known about that block. */
export type BlockMetaMap = Record<string, PageBlock>

/** Whether a step of this block is waiting for review. */
export function isPending(block: PageBlock | undefined, step: ReviewStep): boolean {
  return !!block?.[pendingKey(step) as 'pending:peer']
}

/** The accounts whose changes a step is still waiting on. */
export function contributorsSince(block: PageBlock | undefined, step: ReviewStep): number[] {
  return block?.[pendingKey(step) as 'pending:peer']?.by ?? []
}

/** The latest completed sign-off on a step, if there is one. */
export function reviewOf(block: PageBlock | undefined, step: ReviewStep): Approval | undefined {
  return block?.[reviewKey(step) as 'review:peer']
}

/**
 * Who is looking at a block, as far as the review rule is concerned.
 *
 * `isAdmin` is the ADR 0002 exception — an account that may moderate clears
 * anything, its own writing included. It is
 * `\Drupal\openkb_workflow\ReviewPolicy::mayModerate()`, reported per
 * page on the moderation status; reported, never trusted, since the
 * checkpoint re-derives it.
 */
export interface Reviewer {
  uid: number | null
  isAdmin: boolean
}

/**
 * Whether this reviewer may sign this step of this block off.
 *
 * The client half of `\Drupal\openkb_workflow\PageBlocks::mayApprove()`,
 * derived the same way `blockers()` is and for the same reason: the projection
 * draws the affordance, Drupal still authorizes the write. A raced sign-off
 * is answered by the checkpoint's own refusal, never by this.
 *
 * Three things it says, all of them the server's:
 *
 *  - a step that is not pending has nothing to sign off;
 *  - `agent` asks for a human, not a second one, so any account clears it;
 *  - `peer` is four-eyes — an episode naming nobody cannot be cleared at all
 *    (only an admin can), and an episode naming only this account is the
 *    self-approval the rule exists to withhold.
 *
 * A flag the collaboration server estimated ahead of its checkpoint answers the
 * same three questions and reads no differently. Its baseline is the writer set
 * that server witnessed — the one it will state to Drupal — and the checkpoint
 * carries the sign-off, so the episode and the sign-off reach Drupal's record
 * in the same write.
 */
export function mayApprove(
  block: PageBlock | undefined,
  step: ReviewStep,
  reviewer: Reviewer,
): boolean {
  if (!isPending(block, step) || reviewer.uid == null) return false
  if (step === 'agent' || reviewer.isAdmin) return true
  const writers = contributorsSince(block, step)
  return writers.length > 0 && !(writers.length === 1 && writers[0] === reviewer.uid)
}

/**
 * The blocks holding up a publication, as block id → the steps they owe.
 *
 * The client derives this from the mirrored sidecar to disable Publish and
 * fill the drawer, and Drupal derives the same thing from storage to refuse
 * the write. Two derivations of one rule, never one trusting the other: a
 * raced refusal comes back as the server's own list.
 *
 * `steps` is the space's policy — which steps it asks for. Each block's owed
 * list reads in {@link REVIEW_STEPS} order, agent first.
 */
export function blockers(
  map: BlockMetaMap,
  steps: readonly ReviewStep[] = REVIEW_STEPS,
): Record<string, ReviewStep[]> {
  const out: Record<string, ReviewStep[]> = {}
  for (const id of Object.keys(map).sort()) {
    const owed = REVIEW_STEPS.filter(step => steps.includes(step) && isPending(map[id], step))
    if (owed.length > 0) out[id] = owed
  }
  return out
}

/** What a read surface needs about one block. */
export interface BlockByline {
  /** Every contributor, most recent edit first. */
  contributors: Contributor[]
  /** The steps still waiting. */
  pending: ReviewStep[]
  /** The latest completed sign-off per step. */
  review: Partial<Record<ReviewStep, Approval>>
}

/**
 * The read-time projection of one block: who wrote it, and what review it has
 * had or still owes.
 *
 * Note what is *not* here: a "reviewed" verdict for a block the sidecar says
 * nothing about. Such a block owes nothing, which is not the same as having
 * been read, and rendering it as a tick would credit a review nobody gave.
 */
export function blockByline(block: PageBlock | undefined): BlockByline {
  const contributors = (block?.contributors ?? [])
    .map(c => ({ ...c }))
    .sort((a, b) => b.lastEdit - a.lastEdit)
  const review: Partial<Record<ReviewStep, Approval>> = {}
  for (const step of REVIEW_STEPS) {
    const recorded = reviewOf(block, step)
    if (recorded) review[step] = recorded
  }
  return {
    contributors,
    pending: REVIEW_STEPS.filter(step => isPending(block, step)),
    review,
  }
}

/** Whether a block's sidecar entry says anything worth rendering. */
export function hasRecord(byline: BlockByline): boolean {
  return byline.contributors.length > 0
    || byline.pending.length > 0
    || Object.keys(byline.review).length > 0
}

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

/** Parse the stored sidecar JSON; empty/invalid input yields an empty map. */
export function parseBlockMeta(raw: string | null | undefined): BlockMetaMap {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as BlockMetaMap : {}
  }
  catch {
    return {}
  }
}

/**
 * One contributor with its properties in a fixed order, so two entries holding
 * the same values stringify identically no matter how they were built (parsed
 * from Drupal, merged in the Y.Doc, carried over from an older shape). An
 * unknown display name is left out rather than stored as null — `name` is a
 * read-time convenience, and an absent one must not read as a difference.
 */
function canonicalContributor(c: Contributor): Contributor {
  const { uid, via, name, lastEdit } = c
  return {
    uid: uid ?? null,
    via: via ?? null,
    ...(name ? { name } : {}),
    lastEdit,
  }
}

/**
 * One block in canonical form: block-level keys first in key order, then
 * `contributors` sorted by actor identity. The contributors reach this in
 * whatever order the Y.Map happened to iterate its keys in, which is not part
 * of the data — sorting here is what keeps the commit dirty-check from
 * flapping on it.
 */
function canonicalBlock(block: PageBlock): PageBlock {
  const { contributors, ...rest } = block
  const ordered: Record<string, unknown> = {}
  for (const key of Object.keys(rest).sort()) ordered[key] = (rest as Record<string, unknown>)[key]
  return {
    ...ordered,
    contributors: [...(contributors ?? [])]
      .sort((a, b) => (contributorKey(a) < contributorKey(b) ? -1 : 1))
      .map(canonicalContributor),
  } as PageBlock
}

/**
 * Serialize the sidecar canonically — sorted block ids, and within a block
 * sorted contributors with fixed property order — so equal sidecars produce
 * byte-identical JSON and the commit's dirty check stays deterministic.
 * Returns '' for an empty map so a page with no history stores nothing.
 */
export function serializeBlockMeta(map: BlockMetaMap): string {
  const ids = Object.keys(map).sort()
  if (ids.length === 0) return ''
  const ordered: BlockMetaMap = {}
  for (const id of ids) ordered[id] = canonicalBlock(map[id]!)
  return JSON.stringify(ordered)
}

// ---------------------------------------------------------------------------
// The sidecar in the session document
// ---------------------------------------------------------------------------

/**
 * The sidecar as it lives in the session Y.Doc (OKB-83): ONE flat Y.Map whose
 * keys carry both coordinates of a value — which block, and which field of it:
 *
 *   blockMeta: Y.Map
 *     ├─ "<blockId>\0c:<contributorKey>" → Contributor   // one actor's entry
 *     ├─ "<blockId>\0pending:peer"       → PendingStep
 *     └─ "<blockId>\0<anything else>"    → unknown       // block-level extras
 *
 * The keys carry both coordinates because Y.Map merges per key and nothing
 * else: two peers contributing to the SAME block each write only their own
 * actor's key, so both entries survive the merge. Holding a block's entry as
 * ONE value — a plain object, or a nested Y.Map under the block's key — cannot
 * do that. The plain object loses a whole peer's contribution to
 * last-writer-wins; the nested map loses it only in the window where both
 * peers first touch the block, because the map itself still has to be
 * *created* under one key and that create is last-writer-wins too. A flat key
 * is only ever set, never created, so no such window exists.
 *
 * Keys other than the contributor entries are passed through in both
 * directions untouched, so state beyond them needs no migration — which is how
 * the review flags, which only Drupal ever writes, ride through here.
 *
 * A document may still hold a whole block's entry under the bare block id,
 * from a session that predates this structure. Such an entry is read
 * transparently ({@link readBlockMeta}, and the fields written since override
 * it); nothing rewrites it in place, because the next seed aligns the map to
 * Drupal's own entries and the bare key goes with the rest.
 */

/** Marks a block field as one contributor's entry. */
export const CONTRIBUTOR_PREFIX = 'c:'

/** Separates the block id from the field name; a block id cannot hold NUL. */
const FIELD_SEPARATOR = '\u0000'

/** The root sidecar map of a session document. */
export function blockMetaRoot(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap('blockMeta')
}

/** The key one field of one block's entry is held under. */
export function fieldKey(blockId: string, field: string): string {
  return blockId + FIELD_SEPARATOR + field
}

/** Splits a sidecar key; `field` is null for a whole-block entry. */
function splitKey(key: string): { blockId: string, field: string | null } {
  const at = key.indexOf(FIELD_SEPARATOR)
  return at === -1
    ? { blockId: key, field: null }
    : { blockId: key.slice(0, at), field: key.slice(at + FIELD_SEPARATOR.length) }
}

/** Contributors in actor-identity order — a Y.Map's key order is not data. */
function sorted(contributors: Contributor[]): Contributor[] {
  return [...contributors].sort((a, b) => (contributorKey(a) < contributorKey(b) ? -1 : 1))
}

/** A whole-block value as plain JSON, or null when it holds nothing. */
export function toPageBlock(value: unknown): PageBlock | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const block = value as PageBlock
  return { ...block, contributors: sorted(block.contributors ?? []) }
}

/** The fields one block's entry decomposes into, keyed as stored. */
export function toBlockFields(block: PageBlock): Record<string, unknown> {
  const { contributors, ...rest } = block
  const fields: Record<string, unknown> = { ...rest }
  for (const c of contributors ?? []) fields[CONTRIBUTOR_PREFIX + contributorKey(c)] = c
  return fields
}

/**
 * The whole sidecar of a session document as plain JSON — a read surface's
 * view of it.
 *
 * The client's, in practice: `useEditorSession` re-reads this on every change
 * to the map and projects it into marks, bylines and the review drawer. The
 * commit path does not go through here — it sends Drupal the text, the window
 * and `based_on_changed`, and Drupal derives the sidecar itself. So a live
 * estimate (`server/utils/collab-sidecar.ts`) is read here and reaches Drupal
 * on no path.
 */
export function readBlockMeta(doc: Y.Doc): BlockMetaMap {
  const out: BlockMetaMap = {}
  const contributors = new Map<string, Map<string, Contributor>>()

  // Whole-block entries first, so the fields written since override them.
  for (const [key, value] of blockMetaRoot(doc).entries()) {
    const { blockId, field } = splitKey(key)
    if (field !== null) continue
    const block = toPageBlock(value)
    if (!block) continue
    out[blockId] = { ...block, contributors: [] }
    contributors.set(blockId, new Map((block.contributors ?? []).map(c => [contributorKey(c), c])))
  }

  for (const [key, value] of blockMetaRoot(doc).entries()) {
    const { blockId, field } = splitKey(key)
    if (field === null) continue
    out[blockId] ??= { contributors: [] }
    if (!field.startsWith(CONTRIBUTOR_PREFIX)) {
      (out[blockId] as unknown as Record<string, unknown>)[field] = value
      continue
    }
    const byActor = contributors.get(blockId) ?? new Map<string, Contributor>()
    contributors.set(blockId, byActor)
    byActor.set(field.slice(CONTRIBUTOR_PREFIX.length), value as Contributor)
  }

  for (const [blockId, byActor] of contributors) {
    out[blockId]!.contributors = sorted([...byActor.values()])
  }
  return out
}

/**
 * Aligns the sidecar to exactly `parsed`: fields of blocks it does not hold
 * are dropped, and every field it does hold is (re)written where it differs.
 * Must run inside the caller's transaction — this is the seed path, which
 * brings the whole document in line in one update, and it is how Drupal's
 * review flags reach the live session.
 */
export function writeBlockMeta(doc: Y.Doc, parsed: BlockMetaMap): void {
  const root = blockMetaRoot(doc)
  const wanted = new Map<string, unknown>()
  for (const [blockId, block] of Object.entries(parsed)) {
    for (const [field, value] of Object.entries(toBlockFields(block))) {
      wanted.set(fieldKey(blockId, field), value)
    }
  }
  for (const key of [...root.keys()]) {
    if (!wanted.has(key)) root.delete(key)
  }
  for (const [key, value] of wanted) {
    if (!sameValue(root.get(key), value)) root.set(key, value)
  }
}

/**
 * Value equality of two stored fields, through the canonical serialization —
 * so the property order of a contributor parsed from Drupal is not a
 * difference. Other fields compare as plain JSON.
 */
function sameValue(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown) =>
    value && typeof value === 'object' && 'lastEdit' in (value as Contributor)
      ? serializeBlockMeta({ block: { contributors: [value as Contributor] } })
      : JSON.stringify(value ?? null)
  return canonical(a) === canonical(b)
}

// ---------------------------------------------------------------------------
// Block ids in the content
// ---------------------------------------------------------------------------

/**
 * Stable block ids (`{#b-…}`) as a structured ProseMirror attribute.
 *
 * comark's read/index path lifts a trailing `{#id}` into an `id` prop; the
 * editor's own markdown pipeline did not, so on native blocks the `{#b-…}`
 * survived the round-trip only as literal trailing *text*. These helpers close
 * that gap without changing the wire format:
 *
 *   - {@link liftBlockIds}  runs right after parse — moves a trailing `{#id}`
 *     off a top-level block's text and onto `attrs.id`.
 *   - {@link lowerBlockIds} runs right before serialize — puts it back as
 *     trailing text and clears the attribute, so the markdown bytes are
 *     identical to what comark emits (`## Title {#b-3f9a}`).
 *
 * The id therefore lives structurally in the ProseMirror / Y.js document —
 * where everything above can key on it — yet never leaks a new syntax into the
 * stored markdown, which is also what lets Drupal find the same boundaries
 * with a regex instead of a parser.
 *
 * ## Granularity: TOP-LEVEL blocks only
 *
 * An id is borne only by a **direct child of the document**, and only by a
 * type whose id comark 0.5 round-trips onto that same node:
 *
 *   - `paragraph` / `heading` — trailing `{#id}` text, which comark parses
 *     into the block's own `id` prop (`Title {#b-1}` → `["h2",{"id":"b-1"}]`).
 *   - `callout` / `infobox` / `image` — component fences, which carry the id
 *     natively via the `#id` fence-prop shorthand, except a media-less
 *     image, which has no fence and trails `{#id}` after its `![…](…)`
 *     line (app/editor/nodes/image.ts).
 *
 * Nested blocks never bear an id. A paragraph inside a table cell or a list
 * item is not a review unit: ids minted there leak `{#b-…}` into cell and item
 * text, which is both content noise and — for tables — unparseable back into
 * the same document.
 */

/**
 * Top-level block types that carry their id as trailing `{#id}` text.
 * These are the only native blocks comark parses a trailing attribute onto.
 */
export const TEXT_BLOCK_TYPES = new Set(['paragraph', 'heading'])

/**
 * Container blocks comark has no attribute syntax for — a trailing `{#id}`
 * lands on the wrong node or corrupts the block. They carry their id by
 * riding inside a `::block{#id}` wrapper fence in the serialized markdown:
 * lowerBlockIds wraps them on the way out, liftBlockIds unwraps on the way
 * in, so the live document holds the plain node with `attrs.id` and the wire
 * format stays parseable by comark, which reads the fence as a component.
 */
export const WRAPPED_BLOCK_TYPES = new Set([
  'table',
  'taskList',
  'bulletList',
  'orderedList',
  'codeBlock',
  'blockquote',
  'horizontalRule',
])

/**
 * Every block type that bears a stable id: text blocks (trailing `{#id}`),
 * component fences (`#id` fence-prop shorthand) and wrapped containers
 * (`::block{#id}` fence). These are the review units: the coherence sweep
 * mints an id for each of them and prunes the sidecar to their ids. Only ever
 * applied to direct children of the document. With every producible type
 * id-bearing, nothing an editor writes is unaddressable.
 */
export const ID_BEARING_TYPES = new Set([
  ...TEXT_BLOCK_TYPES,
  ...WRAPPED_BLOCK_TYPES,
  'callout',
  'infobox',
  'image',
])

/**
 * Whether a top-level block holds nothing Drupal would store.
 *
 * Drupal's segmentation drops empty chunks, so an empty text block is not a
 * block there: it can owe no review step and no edit can be credited to it.
 * The editor keeps one after any block that is not a paragraph, so that a
 * reader has somewhere to click below the last one.
 */
export function holdsNothing(node: { type: { name: string }, content: { size: number } }): boolean {
  return TEXT_BLOCK_TYPES.has(node.type.name) && node.content.size === 0
}

/** The `b-` prefix every minted id uses, matching the corpus fixtures. */
export const BLOCK_ID_PREFIX = 'b-'

/**
 * A trailing block-id attribute: optional leading whitespace, then `{#id}` at
 * the very end of the text. `id` is `[\w-]+`, the same shape comark's `#id`
 * shorthand round-trips — anything outside it was never a shorthand id and
 * stays literal text. Drupal's segmentation mirrors this exact pattern.
 */
const TRAILING_ID_RE = /[ \t]*\{#([\w-]+)\}$/

/** A random-source seam so the minter is deterministic under test. */
export type IdSource = () => string

/**
 * Default id source: `b-` + 8 hex chars. Uses Web Crypto where available
 * (browser + Node ≥ 19 global `crypto`), falling back to a pseudo-random draw
 * only if it is not — ids need only be unique within a document, not
 * unguessable.
 */
const defaultIdSource: IdSource = () => {
  const g = (globalThis as { crypto?: Crypto }).crypto
  if (g?.getRandomValues) {
    const bytes = g.getRandomValues(new Uint8Array(4))
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  }
  // No Web Crypto: fall back to Math.random. Not for security — collision
  // avoidance within one document only, and the coherence sweep dedupes.
  return Math.floor(Math.random() * 0x1_0000_0000).toString(16).padStart(8, '0')
}

/** Mints a fresh block id (`b-<hex>`). */
export function mintBlockId(source: IdSource = defaultIdSource): string {
  return BLOCK_ID_PREFIX + source()
}

/**
 * The id a node carries, or null when absent or blank.
 *
 * Takes either node representation — the editor walks live ProseMirror nodes,
 * the commit pipeline walks the JSON, and a block whose id one of them reads
 * and the other does not is a block the review model can flag but never credit.
 * Both carry the answer in the same place, so both read it the same way.
 */
export function blockIdOf(node: { attrs?: unknown }): string | null {
  const id = (node.attrs as { id?: unknown } | undefined)?.id
  return typeof id === 'string' && id !== '' ? id : null
}

/** Whether a node is a review unit when found as a direct child of the doc. */
export function isIdBearing(node: JSONContent): boolean {
  return !!node.type && ID_BEARING_TYPES.has(node.type)
}

/** The document's direct children, or an empty list. */
function topLevel(doc: JSONContent): JSONContent[] {
  return doc.content ?? []
}

/**
 * Every block id currently present at the top level of a document. Nested
 * nodes are not scanned — they are not review units and any `id` attribute
 * left on one (e.g. a top-level paragraph dragged into a list) is inert.
 */
export function collectBlockIds(doc: JSONContent, into: Set<string> = new Set()): Set<string> {
  for (const node of topLevel(doc)) {
    const id = blockIdOf(node)
    if (id && isIdBearing(node)) into.add(id)
  }
  return into
}

/**
 * The shared top-level id pass. `fillMissing` decides whether a block with no
 * id gets one; a **duplicated** id is always re-minted, and `keepers` says
 * which occurrence keeps it, by default the first in document order.
 *
 * Which occurrence keeps the id is load-bearing rather than arbitrary: it is
 * the block the session's accounting described, and therefore the block every
 * comment, contributor and sign-off already points at. Nothing downstream has to
 * follow a rename, because nothing was ever keyed on the occurrence that loses
 * it. That answer is worked out once, in the accounting, from what the block
 * held before rather than from where in the document it sits — see
 * {@link sharedIdKeepers} in server/utils/collab-attribution.ts, which is what
 * a caller hands in here.
 *
 * Document order stands where nothing better is known: for a caller with no
 * accounting behind it (the editor's own minter), and for an id whose
 * occurrences the accounting could not tell apart.
 *
 * An ordinal naming an occurrence this document does not have leaves the id on
 * nothing: every block wearing it is re-minted, and each lands unaccounted and
 * unapprovable until an identified edit re-stamps it. That is the safe
 * direction for an answer that no longer fits — writing is held back for
 * review, never handed to the wrong account — and it is not reachable from a
 * checkpoint, where the pass and the serialization see one document.
 */
function idPass(
  doc: JSONContent,
  source: IdSource,
  fillMissing: boolean,
  keepers?: ReadonlyMap<string, number>,
): IdPassResult {
  // Every id already in the document, so that no re-mint can land on one. That
  // includes an id being kept by a later occurrence than this one, which is
  // reached after the re-mint that has to avoid it.
  const seen = collectBlockIds(doc)
  const minted: string[] = []
  // How many blocks wearing each id this pass has walked past.
  const worn = new Map<string, number>()

  function take(id: string): string {
    seen.add(id)
    minted.push(id)
    return id
  }

  function fresh(): string {
    let id = mintBlockId(source)
    while (seen.has(id)) id = mintBlockId(source)
    return take(id)
  }

  // A duplicate's replacement is derived from the id it duplicates, not drawn
  // from the random source: this pass runs on every serialization, and a fresh
  // draw each time would give the same document a different byte sequence on
  // every commit — the content hash never matches what was last written, so a
  // document nobody is editing writes a revision at every quiet interval, with
  // the block's id (and therefore its whole review history) moving each cycle.
  // Derived, the same duplicate always reaches Drupal under the same id, and
  // the second commit has nothing to write.
  function derived(from: string): string {
    let n = 2
    while (seen.has(`${from}-${n}`)) n++
    return take(`${from}-${n}`)
  }

  const content = topLevel(doc).map((node) => {
    if (!isIdBearing(node)) return node
    const id = blockIdOf(node)
    if (id === null) {
      return fillMissing ? { ...node, attrs: { ...(node.attrs ?? {}), id: fresh() } } : node
    }
    const occurrence = worn.get(id) ?? 0
    worn.set(id, occurrence + 1)
    if (occurrence === (keepers?.get(id) ?? 0)) return node
    return { ...node, attrs: { ...(node.attrs ?? {}), id: derived(id) } }
  })

  return { json: { ...doc, content }, minted }
}

/** What an id pass produced: the new tree and the ids it minted. */
export interface IdPassResult {
  json: JSONContent
  minted: string[]
}

/**
 * Brings a document's top-level ids into a coherent state: every id-bearing
 * block has an id, and every id is unique. Returns a NEW tree plus the list of
 * minted ids (empty when nothing needed one). Pure — the input is untouched.
 *
 * This is the authoritative minter, and the backstop for any block a live
 * editor did not id. Note that it stamps ids onto blocks nobody edited, so the
 * commit path uses the narrower {@link dedupeBlockIds} instead — a commit must
 * not rewrite content the session never touched.
 */
export function mintMissingIds(
  doc: JSONContent,
  source: IdSource = defaultIdSource,
): IdPassResult {
  return idPass(doc, source, true)
}

/**
 * Re-mints only the top-level ids that are *duplicated*, leaving id-less
 * blocks id-less. `keepers` names the occurrence that keeps each shared id;
 * without it, the first in document order does.
 *
 * Splitting a block (Enter at its end) hands the new half a verbatim copy of
 * the original's attributes, id included — so without this, two blocks would
 * share one sidecar key and their contributions would merge into whichever the
 * sidecar happened to resolve. An aliased key is worse than a missing one: a
 * block with no id simply carries no record yet.
 *
 * The replacement is derived from the duplicated id rather than drawn fresh, so
 * a document whose duplicate nobody resolves still serializes to the same bytes
 * every time — see `derived` in {@link idPass}.
 */
export function dedupeBlockIds(
  doc: JSONContent,
  keepers?: ReadonlyMap<string, number>,
  source: IdSource = defaultIdSource,
): IdPassResult {
  return idPass(doc, source, false, keepers)
}

/**
 * Post-parse: strip a trailing `{#id}` off every top-level text block and
 * record it on `attrs.id`, and dissolve every `::block{#id}` wrapper fence
 * onto its content. Returns a new tree; the input is not mutated.
 * Blocks with no trailing id are returned unchanged (id stays its schema
 * default of null), and a `{#id}` inside a nested block (list item, table
 * cell, blockquote) stays literal text — it was never our id to claim.
 */
export function liftBlockIds<T extends JSONContent>(doc: T): T {
  const content = topLevel(doc).flatMap(unwrapBlockWrapper).map(liftTopLevelBlock)
  return { ...doc, ...(doc.content ? { content } : {}) } as T
}

/**
 * A wrapper fence dissolves into its children; its id lands on the first
 * child that does not already carry one closer to the text. The canonical
 * wrapper (what lowerBlockIds writes) holds exactly one container, but the
 * fence is ordinary markdown anybody can author — extra children simply
 * become top-level blocks and id themselves through the coherence sweep.
 */
function unwrapBlockWrapper(node: JSONContent): JSONContent[] {
  if (node.type !== 'blockWrapper') return [node]
  const children = node.content ?? []
  const id = blockIdOf(node)
  if (children.length === 0 || !id) return children
  const [first, ...rest] = children as [JSONContent, ...JSONContent[]]
  return blockIdOf(first) !== null || carriesTrailingId(first)
    ? children
    : [{ ...first, attrs: { ...(first.attrs ?? {}), id } }, ...rest]
}

/** Whether a text block ends in a `{#id}` of its own, about to be lifted. */
function carriesTrailingId(node: JSONContent): boolean {
  if (!node.type || !TEXT_BLOCK_TYPES.has(node.type)) return false
  const tail = node.content?.[node.content.length - 1]
  return tail?.type === 'text' && typeof tail.text === 'string' && TRAILING_ID_RE.test(tail.text)
}

function liftTopLevelBlock(node: JSONContent): JSONContent {
  if (!node.type || !TEXT_BLOCK_TYPES.has(node.type)) return node
  const content = node.content
  if (!content || content.length === 0) return node

  const tail = content[content.length - 1]
  if (tail?.type !== 'text' || typeof tail.text !== 'string') return node

  const match = TRAILING_ID_RE.exec(tail.text)
  if (!match) return node

  const stripped = tail.text.slice(0, match.index)
  return {
    ...node,
    attrs: { ...(node.attrs ?? {}), id: match[1] },
    content: stripped
      ? [...content.slice(0, -1), { ...tail, text: stripped }]
      : content.slice(0, -1),
  }
}

/**
 * Pre-serialize: put each top-level text block's `attrs.id` back as trailing
 * `{#id}` text, and fold each id-carrying container into a `::block{#id}`
 * wrapper fence, clearing the attribute either way — so the markdown
 * serializer emits the id exactly where comark expects it and the bytes match
 * the read path. An id-less container serializes bare, exactly as before it
 * ever had an id. Returns a new tree; the input is not mutated.
 */
export function lowerBlockIds<T extends JSONContent>(doc: T): T {
  const content = topLevel(doc).map(lowerTopLevelBlock)
  return { ...doc, ...(doc.content ? { content } : {}) } as T
}

function lowerTopLevelBlock(node: JSONContent): JSONContent {
  if (node.type && WRAPPED_BLOCK_TYPES.has(node.type)) {
    const id = blockIdOf(node)
    if (!id) return node
    const attrs = { ...(node.attrs as Record<string, unknown>) }
    delete attrs.id
    return {
      type: 'blockWrapper',
      attrs: { id },
      content: [{ ...node, ...(Object.keys(attrs).length > 0 ? { attrs } : { attrs: undefined }) }],
    }
  }
  if (!node.type || !TEXT_BLOCK_TYPES.has(node.type)) return node
  const id = blockIdOf(node)
  if (!id || !node.content) return node

  const content = node.content
  const tail = content[content.length - 1]
  const suffix = `{#${id}}`
  let withId: JSONContent[]
  // Only an unmarked trailing text node may carry the id. Joining a marked one
  // (bold, em, code, link) puts the id inside that mark's delimiters — `**ends
  // bold {#b-1}**` — where it is no longer trailing, and the segmentation on
  // either side stops seeing the block's id at all.
  if (tail?.type === 'text' && typeof tail.text === 'string' && !tail.marks?.length) {
    // A space only when the block already has text — an id-only block (empty
    // content bar the id) would otherwise gain a leading space.
    const sep = tail.text ? ' ' : ''
    withId = [...content.slice(0, -1), { ...tail, text: `${tail.text}${sep}${suffix}` }]
  }
  else {
    // Nothing to append to: the id becomes its own unmarked text node, spaced
    // off whatever precedes it.
    withId = [...content, { type: 'text', text: tail ? ` ${suffix}` : suffix }]
  }
  const attrs = { ...(node.attrs as Record<string, unknown>) }
  delete attrs.id
  return { ...node, attrs, content: withId }
}
