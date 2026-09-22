import { defineEventHandler, getQuery, createError } from 'h3'
import { DrupalJsonApiParams } from 'drupal-jsonapi-params'
import { drupalFetch } from '../utils/drupal'

/**
 * Entity autocomplete for the frontmatter form's reference fields.
 *
 * The form derives which entity type (and bundles) a reference targets from
 * the schema's `x-entity-reference`, then hits this route as the user types.
 * The result is the exact `{ id, label }` shape the `fields` Y.Map stores —
 * `id` is the JSON:API UUID (what a write-back addresses), `label` the
 * denormalized display text.
 *
 * Only the entity types the frontmatter contract can reference are proxied;
 * an unknown type is a 400 rather than an open JSON:API passthrough. The
 * session cookie is forwarded so results respect per-role view access.
 */

interface JsonApiEntityResp {
  data?: Array<{ id: string, attributes?: Record<string, unknown> }>
}

/** Attributes probed for a display label, best first. */
const LABEL_ATTRS = ['display_name', 'name', 'title', 'label'] as const

/** JSON:API resource path per referenceable entity type. */
const RESOURCE_PATH: Record<string, (bundle: string) => string | null> = {
  // Users are a single-bundle entity type; the bundle segment is always `user`.
  user: () => '/jsonapi/user/user',
  // Terms are addressed per vocabulary — the bundle is required.
  taxonomy_term: bundle => (bundle ? `/jsonapi/taxonomy_term/${bundle}` : null),
}

function labelOf(attributes: Record<string, unknown> = {}): string {
  for (const attr of LABEL_ATTRS) {
    const value = attributes[attr]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const entityType = String(query.entity_type ?? '').trim()
  const bundle = String(query.bundle ?? '').trim()
  const q = String(query.q ?? '').trim()

  if (q.length === 0) return { results: [] }

  const resolvePath = RESOURCE_PATH[entityType]
  if (!resolvePath) {
    throw createError({ statusCode: 400, statusMessage: 'Unsupported entity type' })
  }
  // A term reference without a vocabulary can't be addressed in JSON:API.
  if (bundle && !/^[a-z0-9_]+$/.test(bundle)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid bundle' })
  }
  const path = resolvePath(bundle)
  if (!path) {
    throw createError({ statusCode: 400, statusMessage: 'Missing bundle' })
  }

  // `name` is the label carrier on both users and terms, so one filter serves
  // every referenceable type. Labels ride back in the same response.
  const params = new DrupalJsonApiParams()
    .addFilter('name', q, 'CONTAINS')
    .addPageLimit(10)

  const json = await drupalFetch<JsonApiEntityResp>(event, `${path}?${params.getQueryString({ encodeValuesOnly: true })}`)

  return {
    results: (json.data ?? []).map(entity => ({
      id: entity.id,
      label: labelOf(entity.attributes),
    })),
  }
})
