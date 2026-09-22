import {
  fieldSpecs,
  type FieldSpec,
  type FrontmatterSchema,
} from './entity-fields'
import type { AllowedHtml } from '#shared/utils/comark-tree'

/**
 * Drupal source for the collab session's entity field contract.
 *
 * One read, anonymous-safe: `GET /openkb/schema` — the exposure contract, and
 * the body format's allowed HTML list. Cached in-process for SCHEMA_TTL_MS; it
 * changes only when a site-builder edits the `frontmatter` form display or the
 * format, and the collab plugin asks for it on every document load and on
 * every poll tick, the read path on every page render.
 *
 * The values themselves are not read here: they ride on the CE page the body
 * lane already fetched (`mapCeFieldValues` in entity-fields.ts).
 *
 * Failure is always `null` — never a partial payload. The callers treat that
 * as "Drupal did not answer" and leave the document untouched, exactly like
 * the body-seeding path.
 */

const SCHEMA_TTL_MS = 60_000

export interface FieldSource {
  /** Exposed fields per the frontmatter form display, or null when unreachable. */
  fetchSpecs: () => Promise<FieldSpec[] | null>
  /** What the body's text format allows — see `TreeOptions` in comark-tree.ts. */
  fetchAllowedHtml: () => Promise<AllowedHtml | undefined>
}

/**
 * Process-wide field source, shared by the collab plugin and the commit
 * endpoints so they all hit one schema cache. Keyed on the base URL only to
 * stay correct if the runtime config ever changes under a dev reload.
 */
let shared: { baseUrl: string, source: FieldSource } | null = null

export function sharedFieldSource(drupalBaseUrl: string): FieldSource {
  if (!shared || shared.baseUrl !== drupalBaseUrl) {
    shared = { baseUrl: drupalBaseUrl, source: createFieldSource(drupalBaseUrl) }
  }
  return shared.source
}

export function createFieldSource(
  drupalBaseUrl: string,
  now: () => number = () => Date.now(),
): FieldSource {
  const base = drupalBaseUrl.replace(/\/$/, '')
  let cached: { schema: FrontmatterSchema, expiresAt: number } | null = null

  async function fetchSchema(): Promise<FrontmatterSchema | null> {
    if (cached && cached.expiresAt > now()) return cached.schema
    try {
      const res = await fetch(`${base}/openkb/schema`, { headers: { Accept: 'application/json' } })
      if (!res.ok) {
        console.error(`[collab] frontmatter schema fetch → ${res.status}`)
        return null
      }
      const schema = await res.json() as FrontmatterSchema
      cached = { schema, expiresAt: now() + SCHEMA_TTL_MS }
      return schema
    }
    catch (err) {
      console.error('[collab] frontmatter schema fetch failed:', (err as Error).message)
      return null
    }
  }

  async function fetchSpecs(): Promise<FieldSpec[] | null> {
    const schema = await fetchSchema()
    return schema === null ? null : fieldSpecs(schema)
  }

  return {
    fetchSpecs,
    fetchAllowedHtml: async () => (await fetchSchema())?.body?.allowedHtml,
  }
}
