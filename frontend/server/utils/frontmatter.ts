/**
 * `.md` wire format: YAML frontmatter ⇄ entity field values.
 *
 * Frontmatter is a wire format only (`.md` GET/PUT), never the live editing
 * medium — the collab session owns the live values. This module is the codec
 * between that wire format and the `fields` payload OKB-46 defines.
 *
 * The exposure contract is the `frontmatter` form display, published as JSON
 * Schema by `GET /openkb/schema` and read here through {@link FieldSpec}. There
 * is no field list in this file: a field placed/removed in that form mode
 * appears/disappears from the projection, and becomes accepted/rejected on
 * parse, with zero code change. The node title is deliberately *not* part of
 * the frontmatter contract (OKB-9 keeps it in the collab session's title seam),
 * so it is never projected and never accepted here.
 *
 * Value shapes match the `fields` Y.Map (see entity-fields.ts):
 *   - scalar field, cardinality 1  → string | number | boolean | null
 *   - scalar field, multi-value    → list of those
 *   - entity reference             → `{ id, label }` | null
 *   - entity reference, multi      → list of `{ id, label }`
 *
 * Refs project as `{id, label}` mappings — the id is what round-trips to
 * Drupal, the label is what a reader (or agent) needs to make sense of it.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type {
  EntityRef,
  FieldSpec,
  FieldValue,
  FieldValues,
  ScalarFieldValue,
} from './entity-fields'

const DELIMITER = '---'

/**
 * Frontmatter matched at the very start of the document: an opening `---`
 * line, the YAML block, a closing `---` line, and — swallowed so the body
 * survives byte-identical — the newline after it plus one optional blank line.
 */
const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n(\r?\n)?/

/**
 * A PUT `.md` whose frontmatter the exposure contract rejects: an unknown or
 * unexposed key, a malformed YAML block, or a value of the wrong shape for its
 * field. Carries the offending keys so the endpoint can report them without
 * leaking anything internal. Surfaces as a 4xx (OKB-44 taxonomy).
 */
export class FrontmatterError extends Error {
  readonly keys: string[]
  constructor(message: string, keys: string[] = []) {
    super(message)
    this.name = 'FrontmatterError'
    this.keys = keys
  }
}

/**
 * The frontmatter object for a node, in form-display order, over exactly the
 * exposed keys. Missing values default to `null` / `[]` so the shape of an
 * exposed-but-empty field is still visible in the wire format.
 */
export function projectFields(
  specs: FieldSpec[],
  values: FieldValues,
): Record<string, unknown> {
  const projected: Record<string, unknown> = {}
  for (const spec of specs) {
    const value = values[spec.key]
    projected[spec.key] = value ?? (spec.multiple ? [] : null)
  }
  return projected
}

/**
 * Assembles the `.md` document: the projected frontmatter block above the
 * canonical comark/MDC body. With no exposed fields there is nothing to
 * project, so the body is returned as-is (no empty block).
 */
export function projectMarkdown(
  specs: FieldSpec[],
  values: FieldValues,
  body: string,
): string {
  if (specs.length === 0) return body
  const yaml = stringifyYaml(projectFields(specs, values)).replace(/\n$/, '')
  return `${DELIMITER}\n${yaml}\n${DELIMITER}\n\n${body}`
}

/** Splits a `.md` document into its raw frontmatter block and its body. */
export function splitFrontmatter(raw: string): {
  frontmatter: string | null
  body: string
} {
  const match = raw.match(FRONTMATTER_RE)
  if (!match) return { frontmatter: null, body: raw }
  return { frontmatter: match[1], body: raw.slice(match[0].length) }
}

/**
 * Parses and validates a frontmatter block against the exposure contract,
 * returning the field values it carries. Unknown/unexposed keys, a non-mapping
 * block, invalid YAML, or a value of the wrong shape for its field all throw
 * a {@link FrontmatterError}.
 */
export function parseFields(specs: FieldSpec[], frontmatter: string): FieldValues {
  let doc: unknown
  try {
    doc = parseYaml(frontmatter)
  }
  catch (err) {
    throw new FrontmatterError(`Invalid YAML frontmatter: ${(err as Error).message}`)
  }
  if (doc === null || doc === undefined) return {}
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new FrontmatterError('Frontmatter must be a YAML mapping of field keys to values.')
  }

  const specByKey = new Map(specs.map(spec => [spec.key, spec]))
  const record = doc as Record<string, unknown>

  const unknown = Object.keys(record).filter(key => !specByKey.has(key))
  if (unknown.length > 0) {
    throw new FrontmatterError(
      `Unknown frontmatter key(s): ${unknown.join(', ')}. `
      + 'Only fields placed in the frontmatter form mode are accepted.',
      unknown,
    )
  }

  const values: FieldValues = {}
  for (const [key, raw] of Object.entries(record)) {
    values[key] = coerce(specByKey.get(key)!, raw)
  }
  return values
}

function coerce(spec: FieldSpec, raw: unknown): FieldValue {
  if (spec.reference) {
    if (spec.multiple) return asList(spec, raw).map(item => toRef(spec, item))
    if (raw === null || raw === undefined) return null
    return toRef(spec, raw)
  }
  if (spec.multiple) return asList(spec, raw).map(item => toScalar(spec, item))
  return toScalar(spec, raw)
}

function asList(spec: FieldSpec, raw: unknown): unknown[] {
  if (raw === null || raw === undefined) return []
  if (!Array.isArray(raw)) {
    throw new FrontmatterError(`Field "${spec.key}" is multi-valued and must be a YAML list.`, [spec.key])
  }
  return raw
}

function toRef(spec: FieldSpec, raw: unknown): EntityRef {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new FrontmatterError(
      `Field "${spec.key}" expects an entity reference mapping ({ id, label }).`,
      [spec.key],
    )
  }
  const { id, label } = raw as Record<string, unknown>
  if (typeof id !== 'string' || id === '') {
    throw new FrontmatterError(`Field "${spec.key}" reference is missing a string "id".`, [spec.key])
  }
  return { id, label: typeof label === 'string' ? label : '' }
}

function toScalar(spec: FieldSpec, raw: unknown): ScalarFieldValue {
  if (raw === null || raw === undefined) return null
  const type = typeof raw
  if (type === 'string' || type === 'number' || type === 'boolean') return raw as ScalarFieldValue
  throw new FrontmatterError(`Field "${spec.key}" expects a scalar value.`, [spec.key])
}
