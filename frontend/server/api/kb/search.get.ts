import { createError, defineEventHandler, getQuery } from 'h3'
import type { H3Event } from 'h3'
import { isUpdatedRange, UPDATED_RANGES } from '#shared/utils/kb-search'
import { searchKbPages, searchPageSections } from '../../utils/kb-search'
import { fetchFrontmatterSchema } from '../../utils/drupal'
import type { FrontmatterSchema } from '../../utils/entity-fields'

/** The longest an author's name may be, as Drupal's user name field has it. */
const MAX_AUTHOR_LENGTH = 60

/**
 * Knowledge-base search.
 *
 * Two reads behind one route, see `server/utils/kb-search.ts`:
 *   - `titlePrefix=1` — the title match the document-link picker and the
 *     search box's suggest read, answering `hits`;
 *   - anything else — Drupal's `/openkb/search`, answering `pages`: the
 *     sections each page matched for a query, and the newest pages for an
 *     empty one.
 *
 * `space`, `type`, `author` and `updated` narrow the second read, so a filter
 * holds whether or not something is being searched for.
 */
export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const q = typeof query.q === 'string' ? query.q.trim() : ''

  const space = param(query.space)

  if (query.titlePrefix === '1') {
    return searchKbPages(event, { q, space })
  }

  const page = Number(query.page) || 0
  const type = param(query.type)
  const author = param(query.author)
  const updated = param(query.updated)

  await refuseUnknownFilters(event, { type, author, updated })

  return searchPageSections(event, { q, page, space, type, author, updated })
})

/** One filter off the route; an empty one narrows nothing. */
function param(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Refuses a filter no pick could have produced.
 *
 * `type` and `updated` are closed sets, so a value outside them is the request
 * being wrong. `author` is a name: one nobody holds narrows to nothing, the
 * way a slug naming no space does, and only a name no account could carry is
 * refused.
 */
async function refuseUnknownFilters(
  event: H3Event,
  filters: { type?: string, author?: string, updated?: string },
): Promise<void> {
  if (filters.updated && !isUpdatedRange(filters.updated)) {
    throw createError({
      statusCode: 422,
      statusMessage: `An update range is one of ${Object.keys(UPDATED_RANGES).join(', ')}.`,
    })
  }
  if (filters.author && filters.author.length > MAX_AUTHOR_LENGTH) {
    throw createError({
      statusCode: 422,
      statusMessage: `An author is named by their user name, at most ${MAX_AUTHOR_LENGTH} characters.`,
    })
  }
  // The frontmatter form display is the one contract that decides which types
  // exist, so a pick is checked against what an editor could have set.
  if (filters.type && !frontmatterTypeValues(await fetchFrontmatterSchema(event)).includes(filters.type)) {
    throw createError({
      statusCode: 422,
      statusMessage: 'A type is one of the frontmatter schema\'s document types.',
    })
  }
}

/** The document types the frontmatter schema publishes. */
function frontmatterTypeValues(schema: FrontmatterSchema): string[] {
  return schema.properties?.type?.enum ?? []
}
