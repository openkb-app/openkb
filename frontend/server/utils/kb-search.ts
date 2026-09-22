import type { H3Event } from 'h3'
import { createError } from 'h3'
import { fetchUpstream, UPSTREAM_UNAVAILABLE } from './upstream'
import { drupalBaseUrl } from './drupal'
import { forwardedAuthHeaders } from './actor'
import type { PageSearchResponse, SearchPage, SearchSection } from '#shared/utils/kb-search'

/**
 * Knowledge-base search, as Drupal answers it.
 *
 * Every read here is one call to Drupal, forwarded with the caller's own
 * credentials, so which pages come back is Drupal's answer and nothing is
 * filtered by hand on the way (ADR 0004). Two reads sit behind
 * `GET /api/kb/search`:
 *
 *   - {@link searchKbPages} — the document-link picker's title match, off
 *     `/openkb/search?title=`; a bare `[[` lists the newest pages instead.
 *   - {@link searchPageSections} — the search page: the sections each page
 *     matched for a query, and the newest pages for an empty one.
 *
 * **Fail closed.** Unreachable or refusing is an error, never an empty result
 * the UI would show as "no matches".
 */

/** One row a title prefix offers. */
export interface SearchHit {
  /** The search_api item id, `entity:node/<nid>:<langcode>`. */
  id: string
  title: string
  /** The page's space-scoped alias — what a row links to. */
  path: string
  /** The space the page lives in. */
  space: string
  /** The page's document type, by machine name. */
  type: string
  /**
   * The title with the matched words marked, where the prefix reached it.
   *
   * Page text apart from the mark characters, so it is split into parts and
   * interpolated, never set as HTML.
   */
  highlights: string[]
}

/** What a title-prefix read answers. */
export interface SearchResponse {
  query: string
  hits: SearchHit[]
}

/**
 * The pages whose title starts with what the caller has typed.
 *
 * Two surfaces read this: the document-link picker, where a bare `[[`
 * announces an empty query that still has to list pages — there is no prefix
 * to match, so the newest readable pages are what it offers — and the search
 * box's suggest, which never asks with an empty one.
 */
export async function searchKbPages(
  event: H3Event,
  params: { q?: string, space?: string },
): Promise<SearchResponse> {
  const query = (params.q ?? '').trim()
  const url = new URL(`${drupalBaseUrl()}/openkb/search`)
  url.searchParams.set(query === '' ? 'q' : 'title', query)
  if (params.space) url.searchParams.set('space', params.space)

  const body = await askDrupal<{ pages?: Array<Record<string, unknown>> }>(event, url)
  const rows = Array.isArray(body?.pages) ? body.pages : []
  return {
    query,
    hits: rows
      .map(row => ({
        id: typeof row.id === 'string' ? row.id : '',
        title: typeof row.title === 'string' ? row.title : '',
        path: typeof row.path === 'string' ? row.path : '',
        space: typeof row.space === 'string' ? row.space : '',
        type: typeof row.type === 'string' ? row.type : '',
        highlights: (Array.isArray(row.highlights) ? row.highlights : [])
          .filter((entry): entry is string => typeof entry === 'string' && entry !== ''),
      }))
      .filter(hit => hit.path !== ''),
  }
}

/**
 * The caller's own credentials, to forward to Drupal.
 *
 * @throws When the request carries none: an anonymous caller holds no space
 *   and would only ever be answered nothing.
 */
function callerAuth(event: H3Event): Record<string, string> {
  const auth = forwardedAuthHeaders(event)
  if (Object.keys(auth).length === 0) {
    throw createError({ statusCode: 403, statusMessage: 'Sign in to search.' })
  }
  return auth
}

/**
 * One GET of a Drupal search route, with the caller's own credentials.
 *
 * @throws When the caller carries none, or Drupal does not answer.
 */
async function askDrupal<T>(event: H3Event, url: URL): Promise<T | null> {
  const response = await fetchUpstream(url.toString(), {
    headers: { Accept: 'application/json', ...callerAuth(event) },
  })
  if (!response.ok) {
    throw createError({
      statusCode: response.status >= 500 ? 503 : response.status,
      statusMessage: response.status >= 500 ? UPSTREAM_UNAVAILABLE : 'Search could not be run.',
    })
  }
  return (await response.json().catch(() => null)) as T | null
}

/** How many pages one window holds, until Drupal's answer says otherwise. */
const PAGE_SIZE = 10

/** What Drupal's `/openkb/search` answers. */
interface DrupalSearchAnswer {
  query?: string
  page?: number
  page_size?: number
  total?: number | null
  has_more?: boolean
  pages?: Array<Record<string, unknown>>
  refused?: string
  /** Why the route refused the request, where it did. */
  message?: string
}

/**
 * Page search, as Drupal answers it: the sections a query matched, or — for
 * an empty query — the newest pages the caller may read.
 *
 * Fail closed like every other read of Drupal here: unreachable or refusing
 * is an error, never an empty result the UI would show as "no matches".
 */
export async function searchPageSections(
  event: H3Event,
  params: { q: string, page?: number, space?: string, type?: string, author?: string, updated?: string },
): Promise<PageSearchResponse> {
  const query = params.q.trim()
  const page = Math.max(0, Math.trunc(params.page ?? 0))

  const auth = callerAuth(event)

  const url = new URL(`${drupalBaseUrl()}/openkb/search`)
  url.searchParams.set('q', query)
  url.searchParams.set('page', String(page))
  if (params.space) url.searchParams.set('space', params.space)
  if (params.type) url.searchParams.set('type', params.type)
  if (params.author) url.searchParams.set('author', params.author)
  if (params.updated) url.searchParams.set('updated', params.updated)

  const response = await fetchUpstream(url.toString(), {
    headers: { Accept: 'application/json', ...auth },
  })
  const body = await response.json().catch(() => null) as DrupalSearchAnswer | null

  // A refused query answers the no-match state and says why: nothing matches
  // these words, and a retry of them cannot change that. A 422 carrying no
  // page list is the route rejecting the request, which is an error.
  if (!response.ok && !(response.status === 422 && body && Array.isArray(body.pages))) {
    throw createError({
      statusCode: response.status >= 500 ? 503 : response.status,
      statusMessage: response.status >= 500 ? UPSTREAM_UNAVAILABLE : (refusal(body) ?? 'Search could not be run.'),
    })
  }
  if (!body || !Array.isArray(body.pages)) {
    throw createError({ statusCode: 503, statusMessage: UPSTREAM_UNAVAILABLE })
  }

  return {
    query,
    page: typeof body.page === 'number' ? body.page : page,
    pageSize: typeof body.page_size === 'number' ? body.page_size : PAGE_SIZE,
    total: typeof body.total === 'number' ? body.total : null,
    hasMore: body.has_more === true,
    pages: body.pages.map(toPage).filter((row): row is SearchPage => row !== null),
    ...(typeof body.refused === 'string' ? { refused: body.refused } : {}),
  }
}

/**
 * The route's own words for why it refused the request.
 *
 * The one upstream sentence a reader is shown: the route writes it for them,
 * and without it a refusal reads as an outage they could retry away. A
 * sentence is all it ever is, so anything longer is not one.
 */
function refusal(body: DrupalSearchAnswer | null): string | undefined {
  const message = body?.message
  return typeof message === 'string' && message !== '' && message.length <= 200 ? message : undefined
}

/** Drops a row that names no page to link to. */
function toPage(row: Record<string, unknown>): SearchPage | null {
  const path = typeof row.path === 'string' ? row.path : ''
  if (path === '') return null
  const sections = Array.isArray(row.sections) ? row.sections : []
  return {
    id: typeof row.id === 'string' ? row.id : '',
    title: typeof row.title === 'string' ? row.title : '',
    path,
    space: typeof row.space === 'string' ? row.space : '',
    type: typeof row.type === 'string' ? row.type : '',
    tags: (Array.isArray(row.tags) ? row.tags : [])
      .filter((entry): entry is string => typeof entry === 'string' && entry !== ''),
    changed: typeof row.changed === 'number' ? row.changed : 0,
    score: typeof row.score === 'number' ? row.score : 0,
    sections: sections.map(section => toSection(section as Record<string, unknown>, path)),
  }
}

/** One section of a row; a section that spells no anchor links to the page. */
function toSection(row: Record<string, unknown>, pagePath: string): SearchSection {
  const headingPath = Array.isArray(row.heading_path) ? row.heading_path : []
  return {
    blockId: typeof row.block_id === 'string' ? row.block_id : '',
    headingPath: headingPath.filter((entry): entry is string => typeof entry === 'string'),
    excerpt: typeof row.excerpt === 'string' ? row.excerpt : '',
    highlights: (Array.isArray(row.highlights) ? row.highlights : [])
      .filter((entry): entry is string => typeof entry === 'string' && entry !== ''),
    score: typeof row.score === 'number' ? row.score : 0,
    path: typeof row.path === 'string' && row.path !== '' ? row.path : pagePath,
  }
}
