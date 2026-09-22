import { defineEventHandler } from 'h3'
import { DrupalJsonApiParams } from 'drupal-jsonapi-params'
import { drupalFetch, publicDrupalBaseUrl, sitePermissions } from '../utils/drupal'
import { BACKEND_PERMISSION } from '#shared/utils/user'
import { PAGE_CREATE_PERMISSION } from '#shared/utils/kb-spaces'
import { canCreateSpace } from '../utils/spaces'

/**
 * GET /api/me  →  the session's server-derived identity, resolved from the
 * Drupal session cookie ({@link OkbUser}).
 *
 * Two JSON:API requests under the caller's cookie: the root document's
 * `meta.links.me` names the session user's UUID (absent when anonymous), then
 * the user resource supplies name, uid and the `user_picture` file. Anonymous
 * answers nulls with 200; only a broken backend is an error.
 *
 * `isAdmin`, `canCreateSpace` and `canCreatePage` ride along because the chrome
 * needs them before it draws, and this payload already loads once per page. All
 * three come off the permissions Drupal reports for the session ({@link
 * sitePermissions}) — one JSON read, no page rendered; Drupal still decides
 * every access behind them. `canCreatePage` is the site-wide half only: which
 * spaces a page may be created in is `canWrite` on `/api/spaces`.
 */

interface JsonApiRoot {
  meta?: { links?: { me?: { meta?: { id?: string } } } }
}

interface JsonApiUser {
  data?: {
    attributes?: {
      name?: string
      display_name?: string
      drupal_internal__uid?: number
    }
  }
  included?: Array<{ type: string, attributes?: { uri?: { url?: string } } }>
}

/** The included `user_picture` file, absolutised onto the backend origin. */
function pictureUrl(user: JsonApiUser): string | null {
  const url = user.included?.find(file => file.type === 'file--file')?.attributes?.uri?.url
  if (!url) return null
  return url.startsWith('/') ? `${publicDrupalBaseUrl()}${url}` : url
}

export default defineEventHandler(async (event) => {
  const root = await drupalFetch<JsonApiRoot>(event, '/jsonapi')
  const uuid = root.meta?.links?.me?.meta?.id
  if (!uuid) return { name: null, uid: null, picture: null, isAdmin: false, canCreateSpace: false, canCreatePage: false }

  const params = new DrupalJsonApiParams()
    .addFields('user--user', ['name', 'display_name', 'drupal_internal__uid', 'user_picture'])
    .addFields('file--file', ['uri'])
    .addInclude(['user_picture'])
  const user = await drupalFetch<JsonApiUser>(event, `/jsonapi/user/user/${uuid}?${params.getQueryString({ encodeValuesOnly: true })}`)
  const attrs = user.data?.attributes
  const uid = attrs?.drupal_internal__uid ?? null
  const permissions = await sitePermissions(event)
  return {
    // Same precedence as Drupal's own getDisplayName() exposure elsewhere
    // (CE-API current_user, the @-mention search).
    name: attrs?.display_name ?? attrs?.name ?? null,
    uid,
    picture: pictureUrl(user),
    isAdmin: permissions[BACKEND_PERMISSION] === true,
    canCreateSpace: await canCreateSpace(event),
    canCreatePage: permissions[PAGE_CREATE_PERMISSION] === true,
  }
})
