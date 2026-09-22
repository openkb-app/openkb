/**
 * Schema → form-model mapping for the frontmatter form.
 *
 * The only input the form ever reads is `GET /openkb/schema` (openkb_schema
 * module): the JSON Schema derived from the `frontmatter` form display. This
 * module turns that schema into an ordered list of render descriptors — one
 * per exposed field, in the schema's own key order (which the backend already
 * sorts by form-display weight). Nothing here knows a field name: placing,
 * removing or reordering a field in the form display is the only thing that
 * changes the rendered form.
 *
 * A property without `x-field-name` is skipped, exactly like
 * {@link fieldSpecs} on the seeding side: an un-addressable field could not be
 * written back to JSON:API and would blank on the next commit, so it has no
 * business in the form.
 */

/** JSON Schema for one field *item* (the whole property when cardinality 1). */
interface SchemaItem {
  type?: string
  enum?: string[]
  'x-enum-labels'?: Record<string, string>
  'x-entity-reference'?: { entity_type?: string, bundles?: string[] }
}

/** Widget hint carried from the form-display component. */
interface WidgetHint {
  type?: string
  settings?: Record<string, unknown>
}

/** One property of the frontmatter JSON Schema. */
export interface SchemaProperty extends SchemaItem {
  items?: SchemaItem
  title?: string
  description?: string
  maxItems?: number
  'x-widget'?: WidgetHint
  'x-field-name'?: string
}

/** The frontmatter JSON Schema, as served by `GET /openkb/schema`. */
export interface FrontmatterSchema {
  properties?: Record<string, SchemaProperty>
  required?: string[]
}

/** Input control a field renders as. */
export type FrontmatterWidget = 'text' | 'textarea' | 'number' | 'checkbox' | 'select' | 'reference'

export interface FrontmatterSelectOption {
  value: string
  label: string
}

export interface FrontmatterReferenceTarget {
  /** Drupal entity type the reference points at (`user`, `taxonomy_term`, …). */
  entityType: string
  /** Allowed bundles, or `[]` when the field accepts any bundle. */
  bundles: string[]
}

/** A render descriptor for one exposed frontmatter field. */
export interface FrontmatterFormField {
  /** Frontmatter key (machine name minus `field_`) — the `fields` Y.Map key. */
  key: string
  /** JSON:API machine name — what a write addresses. */
  name: string
  label: string
  description?: string
  required: boolean
  /** Cardinality > 1 — the value is an array. */
  multiple: boolean
  widget: FrontmatterWidget
  /** Non-empty only for `select`. */
  options: FrontmatterSelectOption[]
  /** Non-null only for `reference`. */
  reference: FrontmatterReferenceTarget | null
  placeholder?: string
  /** Textarea row hint, when the widget config carries one. */
  rows?: number
}

/**
 * Resolves the input control from the item schema, refined by the widget hint.
 *
 * Type-first (the JSON-Schema type is the contract), then the two structural
 * markers that a bare type can't express — an entity reference is an object
 * with `x-entity-reference`, an enum is a string with `enum`. The widget hint
 * only ever distinguishes a single-line string from a multi-line one; it never
 * overrides the data shape.
 */
function resolveWidget(item: SchemaItem, widget: WidgetHint | undefined): FrontmatterWidget {
  if (item['x-entity-reference'] !== undefined) return 'reference'
  if (Array.isArray(item.enum)) return 'select'
  switch (item.type) {
    case 'boolean':
      return 'checkbox'
    case 'integer':
    case 'number':
      return 'number'
    default:
      return (widget?.type ?? '').includes('textarea') ? 'textarea' : 'text'
  }
}

function enumOptions(item: SchemaItem): FrontmatterSelectOption[] {
  const labels = item['x-enum-labels'] ?? {}
  return (item.enum ?? []).map(value => ({ value, label: labels[value] ?? value }))
}

function referenceTarget(item: SchemaItem): FrontmatterReferenceTarget {
  const ref = item['x-entity-reference'] ?? {}
  return { entityType: ref.entity_type ?? '', bundles: ref.bundles ?? [] }
}

/**
 * Turns the frontmatter JSON Schema into an ordered list of render
 * descriptors. The returned order is the schema's property order, which the
 * backend has already sorted by form-display weight.
 */
export function toFormModel(schema: FrontmatterSchema | null | undefined): FrontmatterFormField[] {
  const properties = schema?.properties ?? {}
  const required = new Set(schema?.required ?? [])
  const fields: FrontmatterFormField[] = []

  for (const [key, property] of Object.entries(properties)) {
    const name = property?.['x-field-name']
    if (!name) continue

    const multiple = property.type === 'array'
    const item: SchemaItem = (multiple ? property.items : property) ?? {}
    const widget = resolveWidget(item, property['x-widget'])
    const settings = property['x-widget']?.settings ?? {}
    const placeholder = settings.placeholder
    const rows = settings.rows

    fields.push({
      key,
      name,
      label: property.title || key,
      description: property.description || undefined,
      required: required.has(key),
      multiple,
      widget,
      options: widget === 'select' ? enumOptions(item) : [],
      reference: widget === 'reference' ? referenceTarget(item) : null,
      placeholder: typeof placeholder === 'string' && placeholder !== '' ? placeholder : undefined,
      rows: widget === 'textarea' && typeof rows === 'number' ? rows : undefined,
    })
  }

  return fields
}
