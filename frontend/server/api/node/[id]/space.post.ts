import { defineEventHandler, getRouterParam, readBody, createError, getHeader } from 'h3'
import { moveKbPageToSpace } from '../../../utils/drupal'
import { resolveSpaceId } from '../../../utils/spaces'

/**
 * POST /api/node/<nid>/space  { space }  →  { nid, space: { id, name } }
 *
 * The deliberate move action (OKB-98, folded into OKB-96): a space is not a
 * frontmatter field an editor can retype, so relocating a page is its own
 * act. `space` is a space UUID or its URL slug.
 *
 * The write goes to `POST /openkb/node/<nid>/space`, which reaches the published
 * revision *and* the forward draft — see
 * \Drupal\openkb_jsonapi\Controller\PageSpaceResource. Access is Drupal's:
 * update access on the page, and `field_space` field access.
 */
export default defineEventHandler(async (event) => {
  const nid = Number(getRouterParam(event, 'id'))
  if (!nid || !Number.isFinite(nid)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid node id' })
  }
  if (!getHeader(event, 'cookie')) {
    throw createError({ statusCode: 401, statusMessage: 'Authentication required — log in via /user/login' })
  }

  const body = await readBody<{ space?: unknown }>(event)
  const space = typeof body?.space === 'string' ? body.space.trim() : ''
  if (!space) {
    throw createError({ statusCode: 400, statusMessage: 'A target space is required' })
  }

  return moveKbPageToSpace(event, nid, await resolveSpaceId(event, space))
})
