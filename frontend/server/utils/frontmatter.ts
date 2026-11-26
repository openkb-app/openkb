/**
 * `.md` wire format: entity field values → YAML frontmatter.
 *
 * Frontmatter is a read format only (`.md` GET), never the live editing
 * medium — the collab session owns the live values. This module projects the
 * `fields` payload OKB-46 defines into that format.
 *
 * The exposure contract is the `frontmatter` form display, published as JSON
 * Schema by `GET /openkb/schema` and read here through {@link FieldSpec}. There
 * is no field list in this file: a field placed/removed in that form mode
 * appears/disappears from the projection with zero code change. The node title
 * is *not* part of the frontmatter contract (OKB-9 keeps it in the collab
 * session's title seam), so it is never projected.
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
import { stringify as stringifyYaml } from 'yaml'
import type { FieldSpec, FieldValues } from './entity-fields'

const DELIMITER = '---'

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
