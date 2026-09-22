import { defineEventHandler, readBody } from 'h3'
import { createSpace, type NewSpace } from '../../utils/spaces'

/**
 * POST /api/spaces  { name, description?, readAccess?, moderation? }  →  { id, slug }
 *
 * A same-origin shim: the browser cannot POST Drupal's JSON:API directly, and
 * the space entity does the gating.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<Partial<NewSpace>>(event)
  return createSpace(event, {
    name: typeof body?.name === 'string' ? body.name.trim() : '',
    description: typeof body?.description === 'string' ? body.description.trim() || undefined : undefined,
    readAccess: body?.readAccess,
    moderation: body?.moderation,
  })
})
