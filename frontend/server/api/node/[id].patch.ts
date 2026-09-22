import { defineEventHandler, getRouterParam, readBody, createError, getHeader } from 'h3'
import { fetchCeNode, patchKbPageBody } from '../../utils/drupal'
import { forwardedAuthHeaders } from '../../utils/actor'
import { storedBody } from '../../utils/title-heading'

/**
 * PATCH /api/node/<nid>  { body, expected_changed }  →  { nid, changed }
 *
 * Optimistic concurrency: the client sends `expected_changed` (the
 * `changed` value it has been editing against). If Drupal's current
 * `changed` doesn't match, return 409 — the editor turns that into the
 * external-change banner and asks the user to reload.
 *
 * On success, return Drupal's new `changed` so the client can advance
 * its local token without an extra GET.
 *
 * The Nuxt server proxies cookie-authed PATCHes to Drupal JSON:API
 * without an extra comark validation pass: Drupal's TypedData
 * constraints on field_kb_body are authoritative. The `body` a caller
 * sends is the document, as every read of a page serves it — the
 * stored title heading is this route's to put back.
 *
 * The lookup is the ce-api read, so a page this session may not read
 * answers 403, and 404 only where the space hides it.
 */
export default defineEventHandler(async (event) => {
  const idParam = getRouterParam(event, 'id')
  const nid = Number(idParam)
  if (!nid || !Number.isFinite(nid)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid node id' })
  }

  if (!getHeader(event, 'cookie')) {
    throw createError({ statusCode: 401, statusMessage: 'Authentication required — log in via /user/login' })
  }

  const { body, expected_changed } = await readBody<{ body: string, expected_changed?: number }>(event)
  const { page } = await fetchCeNode(forwardedAuthHeaders(event), nid)

  // Optimistic concurrency: only enforce if the client supplied an
  // expectation. Clients that don't send one (older callers, agents)
  // get last-writer-wins, same as before.
  if (typeof expected_changed === 'number' && expected_changed > 0 && page.changed !== expected_changed) {
    throw createError({
      statusCode: 409,
      statusMessage: 'External change detected',
      data: { expected: expected_changed, actual: page.changed },
    })
  }

  // The title heading and the final newline are the stored body's, not the
  // document's, so this route writes them like every other write lane
  // (server/utils/title-heading.ts). `page` is the default revision, so a
  // title a forward draft renamed is not the one spelt here.
  const changed = await patchKbPageBody(event, page.id, storedBody(page.titleHeading, page.title, body))
  return { nid, ok: true, changed }
})
