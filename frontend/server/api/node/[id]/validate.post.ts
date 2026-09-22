import { defineEventHandler, getRouterParam, createError, getHeader, readBody } from 'h3'
import { drupalFetch } from '../../../utils/drupal'
import type { FieldValue } from '../../../utils/entity-fields'

/**
 * POST /api/node/<nid>/validate  →  { errors: { <jsonapi field name>: [msg] } }
 *
 * Dry-run validation proxy (OKB-53): forwards the changed field values —
 * session value shapes, keyed by JSON:API field name — to the openkb_schema
 * module's validate route, which runs TypedData validation against the node
 * without writing anything. The caller's session cookie is forwarded and the
 * CSRF token is handled by the shared Drupal bridge; access is the node's
 * update access, the same authority surface as the commit PATCH.
 *
 * Advisory only: the response feeds the FrontmatterForm's per-field error
 * slots while typing. Commit-time validation (OKB-48) stays the gate.
 */
export default defineEventHandler(async (event) => {
  const nid = Number(getRouterParam(event, 'id'))
  if (!nid || !Number.isFinite(nid)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid node id' })
  }
  if (!getHeader(event, 'cookie')) {
    throw createError({ statusCode: 401, statusMessage: 'Authentication required — log in via /user/login' })
  }

  const body = await readBody<{ fields?: Record<string, FieldValue> }>(event)
  const fields = body?.fields
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw createError({ statusCode: 400, statusMessage: 'Body must be { fields: { <field name>: <value> } }' })
  }

  return await drupalFetch<{ errors: Record<string, string[]> }>(
    event,
    `/openkb/node/${nid}/validate`,
    { method: 'POST', body: JSON.stringify({ fields }) },
  )
})
