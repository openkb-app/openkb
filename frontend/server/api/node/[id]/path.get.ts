import { createError, defineEventHandler, getRouterParam, setResponseHeader } from 'h3'
import { parseNodeId } from '#shared/utils/node-address'
import { resolveNodePath } from '../../../utils/node-path'

/**
 * Returns the path of a page, keyed by drupal_internal__nid: `{ path }`.
 *
 * - The in-app navigation to `/node/<nid>` and `/node/<nid>/edit` reads it.
 * - Drupal's refusal of the page read is the answer.
 * - Uncached: the answer depends on the visitor, and a rename moves the path.
 */
export default defineEventHandler(async (event) => {
  const nid = parseNodeId(getRouterParam(event, 'id'))
  if (nid === null) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid node id' })
  }
  setResponseHeader(event, 'Cache-Control', 'private, no-store')
  return { path: await resolveNodePath(event, nid) }
})
