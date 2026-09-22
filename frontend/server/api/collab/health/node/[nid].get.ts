import { defineEventHandler, getRouterParam, createError } from 'h3'
import { useHocuspocus } from '../../../../utils/hocuspocus'
import { inspectDocument, type SettleableDocument } from '../../../../utils/collab-control'
import { documentName } from '../../../../utils/session-read'
import { fetchCeNode } from '../../../../utils/drupal'
import { forwardedAuthHeaders } from '../../../../utils/actor'

const notFound = () => createError({ statusCode: 404, statusMessage: 'Not Found' })

/**
 * Whether one document still has a live collab session: `{ live, connections }`
 * for `node:<nid>`. The aggregate `/api/collab/health` counts the whole server,
 * so a caller waiting on its own document cannot use it.
 *
 * Knowing a document is live is knowing the node exists, so access is decided
 * first, against Drupal under the caller's own carrier. Every refusal — no such
 * node, no VIEW access, anonymous, malformed id, Drupal unreachable — is the
 * same bare 404.
 */
export default defineEventHandler(async (event) => {
  const nid = Number(getRouterParam(event, 'nid'))
  if (!Number.isSafeInteger(nid) || nid <= 0) throw notFound()

  // The ce-api read enforces view access, and its refusal — 403, 404, or a
  // Drupal that cannot be reached — collapses into the one bare 404 above.
  const visible = await fetchCeNode(forwardedAuthHeaders(event), nid).catch(() => null)
  if (!visible) throw notFound()

  const documents = useHocuspocus().documents as unknown as Map<string, SettleableDocument>
  return inspectDocument(documents, documentName(nid))
})
