import { defineEventHandler, getRouterParam, createError } from 'h3'
import type * as Y from 'yjs'
import { forwardedAuthHeaders } from '../../../utils/actor'
import { useHocuspocus } from '../../../utils/hocuspocus'
import { resetDocumentToBody, seedBlockMeta, seedFields } from '../../../utils/doc-seed'
import { drupalBaseUrl } from '../../../utils/drupal'
import { sharedFieldSource } from '../../../utils/drupal-fields'
import {
  commitPublishedContent,
  fetchModerationStatus,
  publishedContent,
} from '../../../utils/moderation'
import { checkpointLiveDocument, moderationWriteError } from '../../../utils/moderation-session'

/**
 * POST /api/node/<nid>/revert  →  { nid, ok, changed, status }
 *
 * Discards the working copy back to the published content — at document
 * granularity (per-block revert is OKB-85, and the diff that previews this is
 * OKB-91; until then the caller confirms).
 *
 * **Nothing is deleted.** The revert writes a NEW draft revision whose content
 * equals the published revision, so the discarded draft stays in the revision
 * list and the published revision was never touched. That is also why the
 * write needs no state of its own: a payload naming no `moderation_state`
 * lands as a draft by the commit route's own content-write rule.
 *
 * Order matters, both ends:
 *
 * 1. **Checkpoint first.** A revert that ran while the session held
 *    uncommitted edits would race the next auto-checkpoint, which would
 *    faithfully re-commit the content just discarded. Settling the session
 *    first makes the revert the last word.
 * 2. **Re-seed the live document last.** Peers converge on the reverted
 *    content in place — no reload banner, no window in which the editor shows
 *    text that is no longer the working copy — and the document's baseline
 *    moves onto the revision just written, so the next checkpoint is a clean
 *    no-op instead of a conflict.
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

  // A never-published page has nothing to revert to. Refusing here (rather
  // than writing the draft's own content back as a new draft, which is what a
  // blind revert would do) keeps the action honest.
  const before = await fetchModerationStatus(auth, nid)
  if (!before.hasPublishedRevision) {
    throw createError({
      statusCode: 409,
      statusMessage: 'This page has never been published — there is nothing to revert to.',
    })
  }

  const hp = useHocuspocus()
  const docName = `node:${nid}`

  const checkpoint = await checkpointLiveDocument(hp, docName, event)
  if (checkpoint.blocked && checkpoint.statusCode !== 422) {
    // A 422 is not a reason to refuse a revert: the pending edits are exactly
    // what the user asked to throw away, and refusing would leave the session
    // wedged behind values it cannot write and cannot discard.
    throw createError({
      statusCode: checkpoint.statusCode,
      statusMessage: checkpoint.message,
      ...(checkpoint.data ? { data: checkpoint.data } : {}),
    })
  }

  const content = await publishedContent(auth, nid, {
    fetchSpecs: sharedFieldSource(drupalBaseUrl()).fetchSpecs,
  })

  let changed: number
  try {
    changed = await commitPublishedContent(auth, nid, content)
  }
  catch (err) {
    throw moderationWriteError(err, 'Revert failed')
  }

  const doc = hp.documents.get(docName) as unknown as Y.Doc | undefined
  if (doc) {
    resetDocumentToBody(doc, content.body, changed)
    // Same revision, every lane: the fields and the provenance sidecar the
    // revert wrote are the baselines the next commit diffs against, or a
    // peer's untouched form reads as an edit back to the draft's values and
    // the sidecar stays keyed to the discarded body's blocks.
    if (Object.keys(content.values).length > 0) seedFields(doc, content.values)
    seedBlockMeta(doc, content.blockMeta)
  }

  return { nid, ok: true, changed, status: await fetchModerationStatus(auth, nid) }
})
