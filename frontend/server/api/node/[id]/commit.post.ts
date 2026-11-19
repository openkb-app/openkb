import { defineEventHandler, getRouterParam, createError, getHeader } from 'h3'
import { useCheckpoint, useHocuspocus } from '../../../utils/hocuspocus'
import { editingCaller } from '../../../utils/moderation-session'

/**
 * POST /api/node/<nid>/commit  →  { nid, ok, committed, changed?, review? }
 *
 * Manual Save-to-history RPC. Runs the one checkpoint path (`useCheckpoint`):
 * the commit pipeline plus the window's accounting in the same write, so a
 * shared burst saved by one peer still credits the others.
 *
 * The caller's carrier is checked with the session's join gate
 * (`editingCaller`), which also names the account the checkpoint states. A
 * token acts as its owner. The write itself goes out under the collaboration
 * server's token.
 *
 * Outcomes map to HTTP so the editor's commit lane reacts as before:
 *   - conflict (409) → external-change banner (data: { expected, actual })
 *   - invalid  (422) → validation error surfaced to the user
 * The commit service also writes these into the doc's `_meta`, so every peer
 * sees the banner/error, not just the caller.
 */
export default defineEventHandler(async (event) => {
  const nid = Number(getRouterParam(event, 'id'))
  if (!nid || !Number.isFinite(nid)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid node id' })
  }

  const cookie = getHeader(event, 'cookie')
  if (!cookie) {
    throw createError({ statusCode: 401, statusMessage: 'Authentication required — log in via /user/login' })
  }
  // The session's join gate: a caller it would not admit must not make the
  // session's pending text durable.
  const identity = await editingCaller(event, nid)
  if (!identity) {
    throw createError({ statusCode: 403, statusMessage: 'You do not have permission to make this change.' })
  }

  const hp = useHocuspocus()
  const docName = `node:${nid}`

  // Normally the caller is a connected editor, so the doc is live in memory.
  // If the last peer just left, load it headlessly so a manual Save still has
  // content to serialize, then release the direct connection.
  let opened: { disconnect: () => Promise<void> } | null = null
  if (!hp.documents.get(docName)) {
    opened = await hp.openDirectConnection(docName, { cookie }) as unknown as { disconnect: () => Promise<void> }
  }

  try {
    // The one write, as this user. Every checkpoint lands as a draft revision,
    // Save included: publishing is its own act (ADR 0003/0004).
    const result = await useCheckpoint()(
      docName,
      'manual',
      identity,
    )
    switch (result.outcome) {
      case 'committed':
        return { nid, ok: true, committed: true, changed: result.changed, review: result.review ?? null }
      case 'clean':
        return { nid, ok: true, committed: false }
      case 'conflict':
        throw createError({
          statusCode: 409,
          statusMessage: 'External change detected',
          data: { expected: result.expected, actual: result.changed },
        })
      case 'invalid':
        throw createError({
          statusCode: 422,
          statusMessage: result.message ?? 'Validation failed',
          // Per-field messages (JSON:API field names). Peers get the same map
          // via _meta.commit_error; this hands it to the caller directly.
          ...(result.fields ? { data: { fields: result.fields } } : {}),
        })
      case 'no-document':
        throw createError({ statusCode: 409, statusMessage: 'No live editing session for this document' })
      case 'empty-body':
        throw createError({ statusCode: 409, statusMessage: 'Editor content is not loaded yet — nothing to save' })
      case 'no-credentials':
        // The caller is authenticated — the collaboration server is not. Its
        // consumer is unprovisioned or its token could not be issued, and
        // every checkpoint carries that credential.
        throw createError({
          statusCode: 503,
          statusMessage: 'The collaboration server has no Drupal credential — run scripts/setup-collab-oauth.sh.',
        })
      default:
        throw createError({ statusCode: 502, statusMessage: result.message ?? 'Commit failed' })
    }
  }
  finally {
    if (opened) await opened.disconnect()
  }
})
