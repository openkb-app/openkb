import { defineEventHandler, getQuery } from 'h3'
import { DrupalJsonApiParams } from 'drupal-jsonapi-params'
import { drupalFetch } from '../../utils/drupal'

/**
 * User search for the editor's @-mention suggestion popover.
 *
 * Also backs the space members form, which adds users to a roster.
 *
 * Forwards the caller's Drupal session cookie to JSON:API so the result set
 * respects per-role view permissions on user entities. Returns a slim shape:
 * uid + name render the chip the editor stores, `id` is the UUID the roster
 * PATCH writes as a JSON:API relationship.
 */
interface JsonApiUserResp {
  data: Array<{
    id: string
    attributes: {
      name: string
      display_name?: string
      drupal_internal__uid: number
    }
  }>
}

export default defineEventHandler(async (event) => {
  const q = String(getQuery(event).q ?? '').trim()
  if (q.length === 0) return { users: [] }

  const params = new DrupalJsonApiParams()
    .addFilter('name', q, 'CONTAINS')
    .addFields('user--user', ['name', 'display_name', 'drupal_internal__uid'])
    .addPageLimit(8)

  const json = await drupalFetch<JsonApiUserResp>(
    event,
    `/jsonapi/user/user?${params.getQueryString({ encodeValuesOnly: true })}`,
  )

  return {
    users: (json.data ?? []).map(u => ({
      id: u.id,
      uid: u.attributes.drupal_internal__uid,
      name: u.attributes.name,
    })),
  }
})
