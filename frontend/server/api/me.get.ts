import { defineEventHandler } from 'h3'
import { DrupalJsonApiParams } from 'drupal-jsonapi-params'
import { drupalFetch, publicDrupalBaseUrl, sitePermissions } from '../utils/drupal'
import { resolveActor } from '../utils/actor'
import { BACKEND_PERMISSION } from '#shared/utils/user'
import { PAGE_CREATE_PERMISSION } from '#shared/utils/kb-spaces'
import { canCreateSpace } from '../utils/spaces'

/**
 * GET /api/me  →  the session's server-derived identity, resolved from the
 * Drupal session cookie ({@link OkbUser}).
 *
 * The acting identity ({@link resolveActor}) names the uid, then the user
 * resource supplies the name and the `user_picture` file. Anonymous — no
 * carrier, or one Drupal does not honor — answers nulls with 200 and never
 * reaches JSON:API, which is closed to it; only a broken backend is an error.
 *
 * `isAdmin`, `canCreateSpace` and `canCreatePage` ride along because the chrome
 * needs them before it draws, and this payload already loads once per page. All
 * three come off the permissions Drupal reports for the session ({@link
 * sitePermissions}) — one JSON read, no page rendered; Drupal still decides
 * every access behind them. `canCreatePage` is the site-wide half only: which
 * spaces a page may be created in is `canWrite` on `/api/spaces`.
 *
 * `canChat` is whether the AI assistant can act for the account. Drupal issues
 * an administrator no agent token: user 1, or an account with an administrator
 * role, which the user resource includes for the accounts that hold one.
 */

interface JsonApiUsers {
  data?: Array<{
    attributes?: {
      name?: string
      display_name?: string
    }
  }>
  included?: Array<{ type: string, attributes?: { uri?: { url?: string }, is_admin?: boolean } }>
}

/** The included `user_picture` file, absolutised onto the backend origin. */
function pictureUrl(user: JsonApiUsers): string | null {
  const url = user.included?.find(file => file.type === 'file--file')?.attributes?.uri?.url
  if (!url) return null
  return url.startsWith('/') ? `${publicDrupalBaseUrl()}${url}` : url
}

/** Whether the account is one Drupal treats as an administrator. */
function isAdministratorAccount(uid: number, user: JsonApiUsers): boolean {
  return uid === 1
    || !!user.included?.some(role => role.type === 'user_role--user_role' && role.attributes?.is_admin === true)
}

export default defineEventHandler(async (event) => {
  const { uid } = await resolveActor(event)
  if (uid == null) return { name: null, uid: null, picture: null, isAdmin: false, canCreateSpace: false, canCreatePage: false, canChat: false }

  const params = new DrupalJsonApiParams()
    .addFilter('drupal_internal__uid', String(uid))
    .addFields('user--user', ['name', 'display_name', 'user_picture', 'roles'])
    .addFields('file--file', ['uri'])
    .addFields('user_role--user_role', ['is_admin'])
    .addInclude(['user_picture', 'roles'])
  const user = await drupalFetch<JsonApiUsers>(event, `/jsonapi/user/user?${params.getQueryString({ encodeValuesOnly: true })}`)
  const attrs = user.data?.[0]?.attributes
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
    canChat: !isAdministratorAccount(uid, user),
  }
})
