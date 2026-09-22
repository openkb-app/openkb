import { defineEventHandler, getRouterParam, createError } from 'h3'
import type * as Y from 'yjs'
import { forwardedAuthHeaders } from '../../../utils/actor'
import { useHocuspocus } from '../../../utils/hocuspocus'
import { advanceDocumentChanged } from '../../../utils/doc-seed'
import { fetchModerationStatus, publishWorkingCopy } from '../../../utils/moderation'
import { checkpointLiveDocument, moderationWriteError } from '../../../utils/moderation-session'

/**
 * POST /api/node/<nid>/publish  →  { nid, ok, changed, status }
 *
 * The deliberate transition. Two steps, in this order:
 *
 * 1. **Checkpoint the live session first.** Publish promotes the *working
 *    copy*, so anything the editor has typed but not committed would be left
 *    behind — they would watch their own screen fail to go live. The
 *    checkpoint is the ordinary commit pipeline and is idempotent, so a
 *    session with nothing pending costs one clean no-op.
 * 2. **Write the transition** through the commit route, which answers to
 *    content_moderation's transition check: an editor without the `publish`
 *    transition is refused by Drupal. The UI hides the button from them, but
 *    hiding is not the gate.
 *
 * Then the live document's concurrency token advances onto the published
 * revision — without that, the session's next checkpoint reads this publish as
 * an external change and 409s.
 */
export default defineEventHandler(async (event) => {
  const nid = Number(getRouterParam(event, 'id'))
  if (!nid || !Number.isFinite(nid)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid node id' })
  }
  const auth = forwardedAuthHeaders(event)
  if (Object.keys(auth).length === 0) {
    throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
  }

  const hp = useHocuspocus()
  const docName = `node:${nid}`

  // Pending edits that cannot be written are a reason not to publish:
  // publishing anyway silently drops what the user is looking at.
  const checkpoint = await checkpointLiveDocument(hp, docName, event)
  if (checkpoint.blocked) {
    throw createError({
      statusCode: checkpoint.statusCode,
      statusMessage: checkpoint.message,
      ...(checkpoint.data ? { data: checkpoint.data } : {}),
    })
  }

  let changed: number
  try {
    changed = await publishWorkingCopy(auth, nid)
  }
  catch (err) {
    throw moderationWriteError(err, 'Publish failed')
  }

  const doc = hp.documents.get(docName) as unknown as Y.Doc | undefined
  if (doc) advanceDocumentChanged(doc, changed)

  return { nid, ok: true, changed, status: await fetchModerationStatus(auth, nid) }
})
