import { createError, defineEventHandler, getRequestURL, sendRedirect, setResponseHeader } from 'h3'
import { withQuery } from 'ufo'
import { isOwnNodePath, parseNodeAddress } from '#shared/utils/node-address'
import { resolveNodePath } from '../utils/node-path'

/**
 * Redirects `/node/<nid>` to the page's path and `/node/<nid>/edit` to
 * `<path>?edit`, keeping the query.
 *
 * - 302: a rename moves the path.
 * - A page whose path is `/node/<nid>` renders there.
 * - A refused read of `/node/<nid>` renders as the address does without the redirect.
 * - A refused read of `/node/<nid>/edit` answers with the read's status.
 */
export default defineEventHandler(async (event) => {
  if (event.method !== 'GET' && event.method !== 'HEAD') return
  const url = getRequestURL(event)
  const address = parseNodeAddress(url.pathname)
  if (!address) return

  let path: string
  try {
    path = await resolveNodePath(event, address.nid)
  }
  catch (error) {
    if (!address.edit) return
    const statusCode = Number((error as { statusCode?: number }).statusCode) || 404
    throw createError({ statusCode, statusMessage: 'Page not found' })
  }
  if (!address.edit && isOwnNodePath(path, address.nid)) return

  const location = address.edit ? withQuery(path + url.search, { edit: '' }) : path + url.search
  setResponseHeader(event, 'Cache-Control', 'private, no-store')
  return sendRedirect(event, location, 302)
})
