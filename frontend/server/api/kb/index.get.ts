import { defineEventHandler } from 'h3'
import { DrupalJsonApiParams } from 'drupal-jsonapi-params'
import { drupalFetch, jsonApiNextPath, JSONAPI_PAGE_SIZE, type JsonApiPage } from '../../utils/drupal'
import { SPACE_TYPE } from '#shared/utils/kb-spaces'

/**
 * Lists kb_page nodes for the home page and the space-grouped sidebar.
 *
 *   GET /api/kb  →  [ { id, path, title, space, changed }, … ]
 *
 * `id` is the page UUID — the name the space outline (OKB-87) stores, so
 * the sidebar can resolve a stored tree against this list.
 *
 * `path` is the canonical Drupal alias (e.g. `/team-wiki/my-document`) —
 * pathauto's `<space-slug>/<page-slug>`, which is how every surface
 * addresses the page.
 *
 * `changed` is the node's own last-changed timestamp as epoch milliseconds, so
 * the home page can order by last edit without a second request. JSON:API ships
 * it as an ISO-8601 string; consumers want a number they can sort and format.
 *
 * `space` is the page's KB space (the `field_space` target), resolved from
 * the JSON:API `included` block in the same request — `{ id, name }`, or
 * `null` for a page with no space assigned. `id` is the space UUID (stable
 * across environments); `/api/spaces` carries the slug a space URL needs.
 *
 * The list is complete, not a first page: it reads the collection to its last
 * page. The sidebar renders whole space trees, so a truncated list would
 * silently amputate every space past the page limit — and a page missing from
 * the tree is a page with no navigation to it at all.
 *
 * Past the first page it reads several pages at a time: JSON:API pages at 50
 * and reports no total, and one request after the other a KB of 5,000 pages
 * costs a hundred round trips in a row.
 *
 * It takes no query parameters: navigation shows every page the session may
 * read. `GET /api/kb/search` is the narrowing read — it takes `space`, `type`,
 * `author` and `updated`, with or without a query.
 */
interface Space {
  id: string
  name: string
}

interface RelationshipRef {
  data?: { id: string, type: string } | null
}

interface KbPageResource {
  id: string
  attributes: { title: string, path: { alias: string } | null, changed: string }
  relationships?: { field_space?: RelationshipRef }
}

interface SpaceResource {
  type: string
  id: string
  attributes: { label: string }
}

interface KbPageCollection extends JsonApiPage {
  data: KbPageResource[]
  included?: SpaceResource[]
}

/** Collection pages requested from Drupal at once. */
const PARALLEL = 6

/** Drupal links `next` only while more rows follow; an empty page ends it too. */
function isLastPage(page: KbPageCollection): boolean {
  return !page.data?.length || !jsonApiNextPath(page)
}

export default defineEventHandler(async (event) => {
  const params = new DrupalJsonApiParams()
    .addFields('node--kb_page', ['title', 'path', 'field_space', 'changed'])
    .addFields(SPACE_TYPE, ['label'])
    .addInclude(['field_space'])
    .addPageLimit(JSONAPI_PAGE_SIZE)
    // Newest first, node id as the tiebreaker. `created` alone is not a total
    // order — a default-content import or a bulk creation stamps a whole batch
    // with one second — and paging an unordered tie lets the database return
    // the same row on two pages and skip another. In a tree that surfaces as
    // one page listed twice and one missing entirely.
    .addSort('created', 'DESC')
    .addSort('drupal_internal__nid', 'DESC')

  const collection = `/jsonapi/node/kb_page?${params.getQueryString({ encodeValuesOnly: true })}`
  const fetchPage = (offset: number) => drupalFetch<KbPageCollection>(
    event,
    offset ? `${collection}&page[offset]=${offset}` : collection,
  )

  // One request for a KB that fits a page. Past it, the next offsets go out
  // together, as many as have been read so far and at most PARALLEL, so a
  // wave that overshoots the end costs a few empty pages and never more
  // requests than the list has used. Pages stay in offset order, whichever
  // answers first.
  const pages = [await fetchPage(0)]
  while (!isLastPage(pages[pages.length - 1]!)) {
    const offset = pages.length * JSONAPI_PAGE_SIZE
    const wave = await Promise.all(
      Array.from({ length: Math.min(PARALLEL, pages.length) }, (_, i) =>
        fetchPage(offset + i * JSONAPI_PAGE_SIZE)),
    )
    const last = wave.findIndex(isLastPage)
    pages.push(...(last === -1 ? wave : wave.slice(0, last + 1)))
  }

  const spacesById = new Map<string, Space>()
  // Keyed by UUID: the sort above makes paging stable, and this keeps the list
  // free of repeats even if it ever is not. Consumers treat the id as unique —
  // the outline keys on it — so a repeat would surface as a page listed twice
  // in the navigation tree.
  const byUuid = new Map<string, KbPageResource>()
  for (const page of pages) {
    for (const node of page.data ?? []) {
      if (!byUuid.has(node.id)) byUuid.set(node.id, node)
    }
    for (const resource of page.included ?? []) {
      if (resource.type === SPACE_TYPE) {
        spacesById.set(resource.id, { id: resource.id, name: resource.attributes.label })
      }
    }
  }

  return [...byUuid.values()].map((node) => {
    const ref = node.relationships?.field_space?.data
    return {
      id: node.id,
      title: node.attributes.title,
      path: node.attributes.path?.alias ?? '',
      space: ref ? spacesById.get(ref.id) ?? null : null,
      changed: Date.parse(node.attributes.changed) || 0,
    }
  })
})
