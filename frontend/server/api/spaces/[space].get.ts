import { createError, defineEventHandler, getRouterParam } from 'h3'
import { findSpaceBySlug, loadSpace } from '../../utils/spaces'

/**
 * One space with its roster, addressed by the slug the sidebar links with.
 *
 *   GET /api/spaces/<slug>  →  { id, internalId, name, slug, description,
 *                                managers, members, viewers, canManage }
 *
 * 404 for an unknown slug — unlike the page list, a space either exists or
 * it does not.
 */
export default defineEventHandler(async (event) => {
  const slug = String(getRouterParam(event, 'space') ?? '')
  const space = await findSpaceBySlug(event, slug)
  if (!space) throw createError({ statusCode: 404, statusMessage: 'Space not found' })
  return loadSpace(event, space.id)
})
