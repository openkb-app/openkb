import type * as Y from 'yjs'
import { DrupalJsonApiParams } from 'drupal-jsonapi-params'
import {
  TITLE_KEY,
  changedFieldKeys,
  type EntityRef,
  type FieldSpec,
  type FieldValue,
  type FieldValues,
} from './entity-fields'
import { fieldsBaseline } from './doc-seed'
import { drupalFetchWithAuth } from './drupal'
import type { KbPagePatchExtra } from './drupal'
import { CommitValidationError, identityAuthHeaders, type CommitContext, type CommitHooks } from './commit'

/**
 * Entity fields in the commit payload — the OKB-48 integration.
 *
 * Everything field-specific about committing lives here, plugged into the
 * commit pipeline's seams ({@link fieldsCommitHooks}) so the core stays
 * field-agnostic:
 *
 *   - dirty predicate: the live `fields` Y.Map diffed against
 *     `_meta.fields_baseline` (what Drupal held at seed time / after the last
 *     commit). A field-only change makes the doc dirty; unchanged doc+fields
 *     stays clean.
 *   - payload extender: the changed keys map onto the single JSON:API PATCH —
 *     scalars (and the node title) as `attributes`, entity references as
 *     `relationships` with their targets resolved and validated first.
 *   - post-commit: `_meta.fields_baseline` advances by exactly the committed
 *     values — never the then-live map — so a peer edit that lands mid-PATCH
 *     still differs from the baseline and reaches the next commit.
 *
 * The value → JSON:API mapping ({@link fieldsPatchPayload}) is shared with the
 * `.md` PUT endpoint: one codec for both persistence surfaces.
 *
 * Reference resolution: the Y.Map stores `{id, label}` with no JSON:API type,
 * and a relationship identifier needs the target's concrete `type--bundle`.
 * Each unique id is resolved against JSON:API under the commit's own auth
 * carrier, across the spec's candidate bundles; an id that resolves nowhere
 * blocks the write with a per-field {@link CommitValidationError} — never a
 * payload Drupal would reject with an opaque 404.
 *
 * One deliberate exception: an unresolvable ref that is already in the
 * session's baseline (`knownRefIds`) was not added by this session — it is a
 * dangling reference whose target got deleted underneath the document
 * (session history, or Drupal-side data the seed picked up). Blocking every
 * subsequent commit on it would silently wedge the whole fields lane behind
 * corruption the user cannot even see (the chip has no label). Such refs are
 * dropped from the written value instead, and {@link fieldsCommitHooks}'
 * post-commit removes them from the live map so the session converges.
 */

/** Resolves a referenced entity id to its JSON:API resource type, or null. */
export type RefTypeResolver = (spec: FieldSpec, id: string) => Promise<string | null>

/**
 * JSON:API type resolver, authed with the commit's own carrier (`auth`) so a
 * resolution can never see more than the writer may. Existence checks a sparse
 * fieldset per candidate bundle (`user` and friends have exactly one); results
 * are memoized for the resolver's lifetime — one payload's worth.
 */
export function createRefTypeResolver(auth: Record<string, string>): RefTypeResolver {
  const cache = new Map<string, string | null>()
  return async (spec, id) => {
    const entityType = spec.entityType ?? ''
    const bundles = spec.bundles?.length ? spec.bundles : [entityType]
    const cacheKey = `${entityType}:${id}`
    if (cache.has(cacheKey)) return cache.get(cacheKey)!

    let resolved: string | null = null
    for (const bundle of bundles) {
      const type = `${entityType}--${bundle}`
      try {
        // Empty sparse fieldset — an existence check that carries no attributes.
        const params = new DrupalJsonApiParams().addFields(type, [])
        await drupalFetchWithAuth(auth, `/jsonapi/${entityType}/${bundle}/${id}?${params.getQueryString({ encodeValuesOnly: true })}`)
        resolved = type
        break
      }
      catch (err) {
        const status = (err as { statusCode?: number })?.statusCode
        // 404: not in this bundle — try the next. Anything else (403, 503) is
        // not evidence of absence; bubble up so the commit errors instead of
        // reporting a false validation failure.
        if (status !== 404) throw err
      }
    }
    cache.set(cacheKey, resolved)
    return resolved
  }
}

function refList(value: FieldValue): EntityRef[] {
  if (value === null || value === undefined) return []
  return (Array.isArray(value) ? value : [value]) as EntityRef[]
}

/**
 * Field values → the JSON:API PATCH fragment, over the given keys.
 *
 * The node title (base field, outside the schema contract) maps to
 * `attributes.title`; scalar specs to `attributes[name]`; references to
 * `relationships[name].data` with each target resolved through `resolveType`.
 * Unresolvable targets and keys without a spec collect into one
 * {@link CommitValidationError} keyed by JSON:API field name — except targets
 * listed in `knownRefIds` (refs the session inherited rather than added),
 * which are dropped from the written value instead (see the header comment).
 */
export async function fieldsPatchPayload(
  specs: FieldSpec[],
  values: FieldValues,
  keys: string[],
  resolveType: RefTypeResolver,
  knownRefIds: Set<string> = new Set(),
): Promise<KbPagePatchExtra> {
  const specByKey = new Map(specs.map(spec => [spec.key, spec]))
  const attributes: Record<string, unknown> = {}
  const relationships: Record<string, unknown> = {}
  const errors: Record<string, string[]> = {}

  for (const key of keys) {
    const value = values[key] ?? null

    if (key === TITLE_KEY) {
      attributes.title = value
      continue
    }

    const spec = specByKey.get(key)
    if (!spec) {
      // A key the exposure contract does not carry cannot be addressed —
      // refusing beats guessing `field_<key>` and writing the wrong field.
      ;(errors[key] ??= []).push(`No exposed field for frontmatter key "${key}".`)
      continue
    }

    if (!spec.reference) {
      attributes[spec.name] = value
      continue
    }

    const identifiers: Array<{ type: string, id: string }> = []
    for (const ref of refList(value)) {
      const type = await resolveType(spec, ref.id)
      if (type === null) {
        if (knownRefIds.has(ref.id)) {
          // Inherited dangling ref — drop it from the write instead of
          // wedging the commit (see the header comment).
          console.warn(`[commit] dropping dangling ${spec.entityType || 'entity'} ref ${ref.id} from ${spec.name}`)
          continue
        }
        ;(errors[spec.name] ??= []).push(
          `Referenced ${spec.entityType || 'entity'} "${ref.label || ref.id}" does not exist.`,
        )
        continue
      }
      identifiers.push({ type, id: ref.id })
    }
    relationships[spec.name] = {
      data: spec.multiple ? identifiers : (identifiers[0] ?? null),
    }
  }

  if (Object.keys(errors).length > 0) {
    throw new CommitValidationError('Validation failed', errors)
  }

  return {
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    ...(Object.keys(relationships).length > 0 ? { relationships } : {}),
  }
}

/** Live `fields` Y.Map as a plain payload. */
function liveFields(doc: Y.Doc): FieldValues {
  return Object.fromEntries(doc.getMap('fields').entries()) as FieldValues
}

/**
 * Keys whose live value has moved off the seed/commit baseline. No baseline
 * (a document predating field seeding) means nothing to diff against — the
 * fields lane stays out of the commit rather than blanking values.
 *
 * The baseline's key set *is* the exposure contract as of the last seed, so a
 * live key the baseline does not carry is not an edit — it is a leftover of a
 * wider contract (a field taken off the `frontmatter` form display while the
 * document sat in the store). Such a key is never dirty; the commit prunes it.
 */
export function dirtyFieldKeys(doc: Y.Doc): string[] {
  const baseline = fieldsBaseline(doc)
  if (!baseline) return []
  return changedFieldKeys(baseline, liveFields(doc)).filter(key => key in baseline)
}

/** Keys the current exposure contract cannot address. */
function staleFieldKeys(keys: string[], specs: FieldSpec[]): string[] {
  const addressable = new Set([TITLE_KEY, ...specs.map(spec => spec.key)])
  return keys.filter(key => !addressable.has(key))
}

/** Every ref id carried in a field payload (single and multi values alike). */
function collectRefIds(values: FieldValues): Set<string> {
  const ids = new Set<string>()
  for (const value of Object.values(values)) {
    for (const ref of refList(value)) {
      if (ref && typeof ref === 'object' && typeof ref.id === 'string') ids.add(ref.id)
    }
  }
  return ids
}

/** The fields lane's read of one commit's document — see {@link captureFields}. */
interface FieldsCapture {
  /** Keys whose value moved off the baseline. */
  dirty: string[]
  /** The values those keys are written from. */
  values: FieldValues
  /** Every live key, for the exposure-contract prune. */
  keys: string[]
  /** Ref ids the session inherited rather than added. */
  baselineIds: Set<string>
}

/**
 * What the fields lane writes for this commit, read in one synchronous pass.
 *
 * Registered as a capture hook, so it runs with the body serialization and
 * before the commit's first await. Reference resolution afterwards talks to
 * Drupal over the network, and the document is live throughout: read there, a
 * concurrent writer's field value would be written into a revision serialized
 * from — and signed for — somebody else's text.
 */
function captureFields(ctx: CommitContext): FieldsCapture {
  const values = liveFields(ctx.doc)
  return {
    dirty: dirtyFieldKeys(ctx.doc),
    values,
    keys: Object.keys(values),
    baselineIds: collectRefIds(fieldsBaseline(ctx.doc) ?? {}),
  }
}

const captures = new WeakMap<CommitContext, FieldsCapture>()

/** This commit's capture. Taken on demand for a caller that registered none. */
function capturedFields(ctx: CommitContext): FieldsCapture {
  let capture = captures.get(ctx)
  if (!capture) {
    capture = captureFields(ctx)
    captures.set(ctx, capture)
  }
  return capture
}

/** Values committed per context — what post-commit advances the baseline by.
 *  These are the values as *written* (inherited dangling refs dropped), never
 *  the then-live map, so a peer edit mid-PATCH still diffs on the next commit. */
const committedValues = new WeakMap<CommitContext, FieldValues>()

/** Dangling ref ids dropped from the write, per field key — post-commit
 *  removes them from the live map so the session converges on clean state. */
const droppedRefIds = new WeakMap<CommitContext, Record<string, Set<string>>>()

/**
 * The commit pipeline's field integration, as hooks for every trigger path
 * (manual RPC + disconnect/quiet/max-dirty checkpoints).
 *
 * `fetchSpecs` failing (schema unreachable) skips the fields lane for this
 * commit instead of blocking the body: the diff lives in the Y.Doc and the
 * baseline has not advanced, so the next trigger retries the same field
 * changes.
 */
export function fieldsCommitHooks(
  fetchSpecs: () => Promise<FieldSpec[] | null>,
): Pick<CommitHooks, 'captures' | 'dirtyChecks' | 'payloadExtenders' | 'postCommit'> {
  return {
    captures: [ctx => void captures.set(ctx, captureFields(ctx))],

    dirtyChecks: [ctx => capturedFields(ctx).dirty.length > 0],

    payloadExtenders: [async (extra, ctx) => {
      const { dirty, values, keys: liveKeys, baselineIds } = capturedFields(ctx)
      if (dirty.length === 0) return extra

      const specs = await fetchSpecs()
      if (specs === null) {
        console.error(`[commit] ${ctx.docName}: frontmatter schema unreachable — field changes deferred to the next commit`)
        return extra
      }

      // A key the current contract cannot address is pruned rather than sent:
      // the exposure contract shrinks (a field leaves the `frontmatter` form
      // display) while documents that predate the change sit in the store.
      const stale = staleFieldKeys(liveKeys, specs)
      if (stale.length > 0) {
        console.log(`[commit] ${ctx.docName}: pruning fields no longer exposed: ${stale.join(', ')}`)
        const meta = ctx.doc.getMap('_meta')
        const fields = ctx.doc.getMap('fields')
        const baseline = { ...(fieldsBaseline(ctx.doc) ?? {}) }
        ctx.doc.transact(() => {
          for (const key of stale) {
            fields.delete(key)
            delete baseline[key]
          }
          meta.set('fields_baseline', baseline)
        })
      }
      const staleSet = new Set(stale)
      const keys = dirty.filter(key => !staleSet.has(key))
      if (keys.length === 0) return extra

      // Refs already in the baseline were inherited, not added here — an
      // unresolvable one among them is dropped from the write, not an error.
      const payload = await fieldsPatchPayload(
        specs, values, keys, createRefTypeResolver(identityAuthHeaders(ctx.identity)), baselineIds,
      )

      // Advance-by and converge-on what was actually WRITTEN: for ref fields
      // that is the live value minus any dropped dangling refs.
      const specByKey = new Map(specs.map(spec => [spec.key, spec]))
      const written: FieldValues = {}
      const dropped: Record<string, Set<string>> = {}
      for (const key of keys) {
        const spec = specByKey.get(key)
        if (!spec?.reference) {
          written[key] = values[key] ?? null
          continue
        }
        const data = (payload.relationships?.[spec.name] as { data?: EntityRef | EntityRef[] | null } | undefined)?.data
        const writtenIds = new Set(refList(data as FieldValue).map(ref => ref.id))
        const liveRefs = refList(values[key] ?? null)
        const keptRefs = liveRefs.filter(ref => writtenIds.has(ref.id))
        written[key] = spec.multiple ? keptRefs : (keptRefs[0] ?? null)
        const droppedHere = liveRefs.filter(ref => !writtenIds.has(ref.id)).map(ref => ref.id)
        if (droppedHere.length > 0) dropped[key] = new Set(droppedHere)
      }
      committedValues.set(ctx, written)
      droppedRefIds.set(ctx, dropped)
      const attributes = { ...(extra.attributes ?? {}), ...(payload.attributes ?? {}) }
      const relationships = { ...(extra.relationships ?? {}), ...(payload.relationships ?? {}) }
      return {
        ...extra,
        ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
        ...(Object.keys(relationships).length > 0 ? { relationships } : {}),
      }
    }],

    postCommit: [(result, ctx) => {
      const committed = committedValues.get(ctx)
      if (!result.committed || !committed) return
      const meta = ctx.doc.getMap('_meta')
      const fields = ctx.doc.getMap('fields')
      const dropped = droppedRefIds.get(ctx) ?? {}
      const baseline = (meta.get('fields_baseline') as FieldValues | undefined) ?? {}
      ctx.doc.transact(() => {
        meta.set('fields_baseline', { ...baseline, ...committed })
        // Remove dropped dangling refs from the live map, subtracting from the
        // *then-live* value so a peer's mid-PATCH addition survives.
        for (const [key, ids] of Object.entries(dropped)) {
          const live = fields.get(key) as FieldValue
          const liveRefs = refList(live)
          if (!liveRefs.some(ref => ids.has(ref.id))) continue
          const kept = liveRefs.filter(ref => !ids.has(ref.id))
          fields.set(key, Array.isArray(live) ? kept : (kept[0] ?? null))
        }
      })
    }],
  }
}
