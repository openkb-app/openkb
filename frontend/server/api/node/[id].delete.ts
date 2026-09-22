import { defineEventHandler, getRouterParam, createError, getHeader } from 'h3'
import { deleteKbPage, fetchCeNode, probeDeleteAccess } from '../../utils/drupal'
import { forwardedAuthHeaders } from '../../utils/actor'
import { useCollabControl } from '../../utils/hocuspocus'

/**
 * DELETE /api/node/<nid>  →  { nid, ok, path, title }
 *
 * The delete is a *soft* delete: the trash module swaps the node storage class
 * for one whose delete() stamps a `deleted` timestamp, so this JSON:API DELETE
 * moves the page to the trash bin instead of removing it. Nothing here says
 * so — that is the point of trash's interception — but it is what the page
 * becoming a 404 everywhere while still being restorable from Drupal admin
 * means. The write is still a write on the node's rows, so the settle below is
 * needed exactly as much as it was for a hard delete.
 *
 * Two things make this more than a JSON:API proxy:
 *
 *   - Access is Drupal's, asked *before* anything is torn down
 *     (`canDeleteNode`, the delete-form probe). JSON:API would refuse an
 *     unauthorized delete anyway; asking first is what keeps a 403 from
 *     costing every peer their live session.
 *   - The collab session is settled first (server/utils/collab-control.ts).
 *     A checkpoint PATCH overlapping this DELETE deadlocks in InnoDB and the
 *     loser gets a 500 (OKB-90) — with the settle, the collab server has no
 *     write in flight against this node and cannot start one.
 *
 * The response carries the deleted page's `path` and `title` so the caller
 * can name it in a toast after it has stopped existing.
 */
export default defineEventHandler(async (event) => {
  const nid = Number(getRouterParam(event, 'id'))
  if (!nid || !Number.isFinite(nid)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid node id' })
  }

  if (!getHeader(event, 'cookie')) {
    throw createError({ statusCode: 401, statusMessage: 'Authentication required — log in via /user/login' })
  }

  // Access before the lookup, so a refusal costs nothing: the probe is the
  // delete form's own answer and separates "gone" from "not yours".
  const access = await probeDeleteAccess(event, nid)
  if (!access.allowed) {
    throw access.missing
      ? createError({ statusCode: 404, statusMessage: 'Page not found' })
      : createError({ statusCode: 403, statusMessage: 'No permission to delete this page' })
  }

  // The live revision — what the read page, and so the menu this arrives from,
  // is showing. A page that never got published serves its draft here.
  const { page } = await fetchCeNode(forwardedAuthHeaders(event), nid)

  await useCollabControl().settle(`node:${nid}`)
  await deleteKbPage(event, page.id)

  return { nid, ok: true, path: page.path, title: page.title }
})
