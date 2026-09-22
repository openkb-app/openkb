import type { AllowedHtml } from '#shared/utils/comark-tree'

/**
 * Entity fields for the collab session — the `fields` Y.Map lane.
 *
 * The body lives in the `default` XML fragment; everything else the editor
 * owns (frontmatter fields + the node title) lives in a flat `fields` Y.Map,
 * one entry per exposed key. Y.Map is per-key last-writer-wins, so two peers
 * editing *different* fields never conflict and two peers editing the *same*
 * field converge on one value — as long as every write replaces a whole key
 * (never a partial in-place mutation of a stored object). All helpers here
 * follow that rule.
 *
 * Exposure contract: `GET /openkb/schema` (openkb_schema module) derives the
 * frontmatter properties from the `frontmatter` form display. There is no
 * field list in this file — placing a field in that display is what makes it
 * appear in the session. Each property carries `x-field-name` (JSON:API
 * machine name), so nothing has to reconstruct `field_<key>` by convention.
 *
 * The node title is the one key not in that schema: it is a base field, and
 * OKB-9 keeps it deliberately out of the frontmatter contract while the
 * collab session still owns it (title edits belong in the same lane as the
 * fields they sit next to). {@link TITLE_KEY} is that single documented seam.
 *
 * Value shapes stored in the Y.Map:
 *   - scalar field, cardinality 1   → string | number | boolean | null
 *   - scalar field, multi-value     → array of those
 *   - entity reference              → `{ id, label }` (id = UUID) | null
 *   - entity reference, multi-value → array of `{ id, label }`
 */

/** Key of the node title in the `fields` map (base field, not in the schema). */
export const TITLE_KEY = 'title'

export interface EntityRef {
  /** UUID of the referenced entity — what JSON:API writes back. */
  id: string
  /** Display label, denormalized for rendering without a second fetch. */
  label: string
}

export type ScalarFieldValue = string | number | boolean | null
export type FieldValue = ScalarFieldValue | EntityRef | Array<ScalarFieldValue | EntityRef>

/** One exposed field, as derived from the published JSON Schema. */
export interface FieldSpec {
  /** Frontmatter key (machine name minus `field_`). */
  key: string
  /** JSON:API field name. */
  name: string
  /** Cardinality > 1 — the Y.Map entry holds an array. */
  multiple: boolean
  /** Entity reference — the Y.Map entry holds `{id, label}` objects. */
  reference: boolean
  /** Reference target entity type (`user`, `taxonomy_term`, …); refs only. */
  entityType?: string
  /** Allowed target bundles; `[]` when the field accepts any bundle. */
  bundles?: string[]
}

export type FieldValues = Record<string, FieldValue>

interface SchemaProperty {
  type?: string
  items?: SchemaProperty
  /** The values a list field accepts, in the order the field declares them. */
  enum?: string[]
  'x-field-name'?: string
  'x-entity-reference'?: { entity_type?: string, bundles?: string[] }
}

export interface FrontmatterSchema {
  properties?: Record<string, SchemaProperty>
  /** The body text format's allowed list. Absent where it restricts nothing. */
  body?: { allowedHtml?: AllowedHtml }
}

/**
 * Reads the exposure contract out of the published JSON Schema.
 *
 * A property without `x-field-name` is skipped rather than guessed at: an
 * un-addressable field would seed as `undefined` and silently blank the value
 * on the next commit.
 */
export function fieldSpecs(schema: FrontmatterSchema | null | undefined): FieldSpec[] {
  const properties = schema?.properties ?? {}
  const specs: FieldSpec[] = []
  for (const [key, property] of Object.entries(properties)) {
    const name = property?.['x-field-name']
    if (!name) continue
    const multiple = property.type === 'array'
    const item = multiple ? (property.items ?? {}) : property
    const target = item['x-entity-reference']
    specs.push({
      key,
      name,
      multiple,
      reference: target !== undefined,
      ...(target !== undefined
        ? { entityType: target.entity_type ?? '', bundles: target.bundles ?? [] }
        : {}),
    })
  }
  return specs
}

/**
 * Unwraps Drupal's field item shape to a plain JSON value.
 *
 * Text fields with a format serialize as `{value, format}`; the session edits
 * the raw value and the format stays Drupal's business.
 */
function scalarValue(raw: unknown): ScalarFieldValue {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'object') {
    const value = (raw as { value?: unknown }).value
    return value === undefined ? null : value as ScalarFieldValue
  }
  return raw as ScalarFieldValue
}

/**
 * CE-API props → the `fields` Y.Map payload.
 *
 * `custom_elements.entity_ce_display.node.kb_page.full` names each
 * frontmatter prop after its frontmatter key, and renders every reference with
 * a `uuid` and a raw `label` — {@link EntityRef} under CE's names. That naming
 * is what keeps this a mapping rather than a field list: the specs still come
 * from `GET /openkb/schema`.
 *
 * An empty or unreadable field ships no prop at all (custom_elements drops
 * both), so a missing key seeds as `null` / `[]` — the same shape the wire
 * format gives an exposed-but-empty field.
 */
export function mapCeFieldValues(
  specs: FieldSpec[],
  props: Record<string, unknown>,
): FieldValues {
  const values: FieldValues = {
    [TITLE_KEY]: typeof props.title === 'string' ? props.title : '',
  }
  for (const spec of specs) {
    const raw = props[spec.key]
    if (spec.reference) {
      const items = (Array.isArray(raw) ? raw : [raw]).filter(item => item != null)
      const refs = items.map(item => ceRef(item as Record<string, unknown>))
      values[spec.key] = spec.multiple ? refs : (refs[0] ?? null)
      continue
    }
    if (spec.multiple) values[spec.key] = (Array.isArray(raw) ? raw : []).map(scalarValue)
    else values[spec.key] = scalarValue(raw)
  }
  return values
}

function ceRef(item: Record<string, unknown>): EntityRef {
  return {
    id: typeof item.uuid === 'string' ? item.uuid : '',
    label: typeof item.label === 'string' ? item.label : '',
  }
}

/**
 * Value-equality over two field payloads.
 *
 * Used to tell an external Drupal-side field change from "the session's own
 * baseline, unchanged". Order matters for multi-value fields — Drupal's delta
 * order is meaningful and a reordering is a real change.
 */
export function fieldValuesEqual(a: FieldValues, b: FieldValues): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if (JSON.stringify(a[key] ?? null) !== JSON.stringify(b[key] ?? null)) return false
  }
  return true
}

/** Keys whose value differs between two payloads. */
export function changedFieldKeys(from: FieldValues, to: FieldValues): string[] {
  const keys = new Set([...Object.keys(from), ...Object.keys(to)])
  return [...keys].filter(
    key => JSON.stringify(from[key] ?? null) !== JSON.stringify(to[key] ?? null),
  ).sort()
}
