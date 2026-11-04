import { defineEventHandler, createError } from 'h3'
import { renderStoredBody, wordsBracketsComponentsOrImagesDiffer } from '../../utils/comark-render'
import { readCappedBody } from '../../utils/capped-body'
import { requireSidecarSecret } from '../../utils/sidecar-secret'

/** The largest body taken: the cap `/api/comark/indexable` sets, room for `data:` images included. */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/**
 * Re-spells a stored page body for Drupal's `BodyRenderer`.
 *
 *   POST /api/comark/render   { "markdown": "…" }
 *
 * - Returns { markdown, textChanged }: the body as the editor writes it
 *   (`renderStoredBody`), and whether its words, brackets, components or raw images
 *   differ from the stored ones, or their order.
 * - Internal: requires the key derived from the shared secret
 *   (`requireSidecarSecret`).
 */
export default defineEventHandler(async (event) => {
  requireSidecarSecret(event)
  const raw = await readCappedBody(event, MAX_BODY_BYTES)
  let body: { markdown?: unknown } | undefined
  try {
    body = raw.byteLength > 0 ? JSON.parse(raw.toString('utf8')) : undefined
  }
  catch {
    throw createError({ statusCode: 400, statusMessage: 'Invalid JSON body' })
  }
  if (typeof body?.markdown !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'Missing markdown' })
  }
  const markdown = await renderStoredBody(body.markdown)
  return { markdown, textChanged: wordsBracketsComponentsOrImagesDiffer(body.markdown, markdown) }
})
