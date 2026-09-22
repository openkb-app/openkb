import { createError, defineEventHandler, getRouterParam, readBody } from 'h3'
import { findSpaceBySlug, writeOutline } from '../../../utils/spaces'
import { type Outline } from '#shared/utils/kb-outline'

/**
 * Replaces a space's page tree.
 *
 *   PATCH /api/spaces/<slug>/outline
 *     { outline: [ { id, children }, … ], expect: [ … ] }
 *      →  { outline }  — the tree as Drupal stored it
 *
 * One request per drag, whichever axis it moved on: reorder and re-parent are
 * the same write of the same whole tree. No page is saved, so no revision
 * is minted and no moderation state can hold a structure change back. Separate
 * from the roster PATCH on purpose — a drag has no business sending a
 * membership list — and gated separately too: it forwards to a Drupal route of
 * its own, which asks whether the caller may restructure this space.
 *
 * `expect` is the tree as the caller last read it. Drupal refuses the write
 * when the field no longer holds it, so a drag that lost a race comes back as
 * a 409 and the client repaints instead of clobbering.
 *
 * The tree's shape is not re-checked here: the `outline` field's constraints
 * own it, so a bad tree fails identically for this endpoint, a raw JSON:API
 * PATCH and an agent. Only the envelope is checked, to answer an obviously
 * malformed request as a 400 rather than a forwarded 422.
 */
interface OutlineBody {
  outline?: unknown
  expect?: unknown
}

function assertOutline(value: unknown, field: string): Outline {
  if (!Array.isArray(value)) {
    throw createError({ statusCode: 400, statusMessage: `${field} must be an array` })
  }
  for (const node of value) {
    if (!node || typeof node !== 'object' || typeof (node as { id?: unknown }).id !== 'string') {
      throw createError({ statusCode: 400, statusMessage: `every ${field} entry needs a string id` })
    }
    const children = (node as { children?: unknown }).children
    if (children !== undefined) assertOutline(children, field)
  }
  return value as Outline
}

export default defineEventHandler(async (event) => {
  const slug = String(getRouterParam(event, 'space') ?? '')
  const body = await readBody<OutlineBody>(event)
  const outline = assertOutline(body?.outline, 'outline')
  const expect = assertOutline(body?.expect, 'expect')

  const space = await findSpaceBySlug(event, slug)
  if (!space) throw createError({ statusCode: 404, statusMessage: 'Space not found' })

  return { outline: await writeOutline(event, space.internalId, outline, expect) }
})
