import { isOwnNodePath, parseNodeAddress } from '#shared/utils/node-address'

/**
 * Leads an in-app navigation to `/node/<nid>` to the page's path, and one to
 * `/node/<nid>/edit` to `<path>?edit`, keeping query and hash.
 *
 * - Client navigations only: a hard load gets the redirect, or the refusal of
 *   `/edit`, from Nitro (server/middleware/node-path.ts).
 * - A refused lookup of `/node/<nid>`, and a page without an alias, render there.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  if (import.meta.server || useNuxtApp().isHydrating) return
  const address = parseNodeAddress(to.path)
  if (!address) return

  let path: string
  try {
    path = (await $fetch<{ path: string }>(`/api/node/${address.nid}/path`)).path
  }
  catch (error) {
    if (!address.edit) return
    const statusCode = Number((error as { statusCode?: number }).statusCode) || 404
    return abortNavigation(createError({ statusCode, statusMessage: 'Page not found', fatal: true }))
  }
  if (!address.edit && isOwnNodePath(path, address.nid)) return

  const query = address.edit ? { ...to.query, edit: null } : to.query
  return navigateTo({ path, query, hash: to.hash }, { replace: true })
})
