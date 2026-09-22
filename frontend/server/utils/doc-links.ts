import { DrupalJsonApiParams } from 'drupal-jsonapi-params'
import { drupalFetchWithAuth, jsonApiNextPath, JSONAPI_PAGE_SIZE, type JsonApiPage } from './drupal'
import { blockVersions } from './block-versions'
import { bodyForms } from './kb-read'
import { splitTitleHeading } from './title-heading'
import type { ResolvedDoc } from '#shared/utils/doc-links'
import type { ResolvedCite } from '#shared/utils/comark-tree'

/**
 * Batch nid resolution for the body's inline references — `:doc[…]{nid="…"}`
 * links and `:citation{nid="…"}` citations — read under the caller's own auth
 * carrier.
 *
 * Access needs no check here: a JSON:API collection is already filtered to the
 * spaces the session may read (`openkb_space_access`), so an unreadable target
 * is absent, exactly as a deleted one is. The read is per reader and never
 * cached; it rides the CE enrichment of the body
 * (server/utils/drupal-ce-enrich.ts). Every page of the collection is read,
 * since absence renders a target as unreadable.
 */

interface PageResource {
  attributes?: {
    drupal_internal__nid?: number
    title?: string
    path?: { alias?: string | null } | null
    field_kb_body?: { value?: string } | null
  }
}

interface KbPageCollection extends JsonApiPage {
  data?: PageResource[]
}

/**
 * The requested pages, each as whatever `build` makes of it.
 *
 * A page with no alias has no address to link to, so it is left
 * unresolved.
 */
async function resolvePages<T>(
  auth: Record<string, string>,
  nids: number[],
  fields: string[],
  build: (page: { title: string, path: string, body: string }) => T,
): Promise<Record<number, T>> {
  if (nids.length === 0) return {}

  const params = new DrupalJsonApiParams()
    .addFilter('drupal_internal__nid', nids.map(String), 'IN')
    .addFields('node--kb_page', ['drupal_internal__nid', 'title', 'path', ...fields])
    .addPageLimit(JSONAPI_PAGE_SIZE)

  const resolved: Record<number, T> = {}
  let path: string | null
    = `/jsonapi/node/kb_page?${params.getQueryString({ encodeValuesOnly: true })}`
  // At most one row per requested nid, so the page count is known up front and
  // a `next` that does not advance cannot spin the request.
  let pagesLeft = Math.ceil(nids.length / JSONAPI_PAGE_SIZE) + 1

  try {
    while (path && pagesLeft-- > 0) {
      const page = await drupalFetchWithAuth<KbPageCollection>(auth, path)
      for (const node of page.data ?? []) {
        const nid = node.attributes?.drupal_internal__nid
        const title = node.attributes?.title
        const alias = node.attributes?.path?.alias
        if (typeof nid !== 'number' || !title || !alias) continue
        resolved[nid] = build({ title, path: alias, body: node.attributes?.field_kb_body?.value ?? '' })
      }
      path = page.data?.length ? jsonApiNextPath(page) : null
    }
  }
  catch (error) {
    // A failed read leaves the targets unresolved, which renders as the stored
    // label for a link and as a dangling citation for a citation.
    console.error('[doc-links] resolution failed:', error)
  }
  return resolved
}

/** What a document link renders as: the target's live title and its alias. */
export function resolveDocNids(
  auth: Record<string, string>,
  nids: number[],
): Promise<Record<number, ResolvedDoc>> {
  return resolvePages(auth, nids, [], ({ title, path }) => ({ title, path }))
}

/**
 * The same, plus each page's current block versions.
 *
 * A citation names the version of the block it was made against, so what a
 * reader needs is that block's version now: equal is a live citation, different
 * is a stale one, absent is a dangling one (#shared/utils/citations.ts). The
 * versions are derived, never stored — hashed off the page's canonical body
 * exactly as a read of that page derives them (server/utils/block-versions.ts),
 * so the two can never disagree.
 */
export function resolveCiteNids(
  auth: Record<string, string>,
  nids: number[],
): Promise<Record<number, ResolvedCite>> {
  return resolvePages(auth, nids, ['field_kb_body'], ({ title, path, body }) => ({
    title,
    path,
    versions: blockVersions(bodyForms(splitTitleHeading(body).body).canonical),
  }))
}
