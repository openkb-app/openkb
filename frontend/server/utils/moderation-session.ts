import { getHeader, createError, type H3Event } from 'h3'
import type { Hocuspocus } from '@hocuspocus/server'
import { resolveActor } from './actor'
import type { CommitIdentity } from './commit'
import { useCheckpoint } from './hocuspocus'
import type { Violation } from './upstream'

/**
 * The live-session side of the moderation actions (OKB-84).
 *
 * Publish and Revert both act on a page that may have a collab session
 * open on it, and both have to reckon with the session rather than write past
 * it: Publish promotes the working copy, so uncommitted edits must be
 * checkpointed into it first; Revert replaces the working copy, so a
 * checkpoint racing it would resurrect what was just discarded.
 *
 * One helper for both, because the sequencing is the same and getting it
 * wrong is silent: the failure mode is not an error, it is content quietly
 * lost.
 */

/**
 * Who a checkpoint triggered by this request acts as.
 *
 * An agent hands over a token; the write goes out under it, as its owner. A
 * person hands over a cookie, which is not a write carrier — resolve it to
 * their account, which the checkpoint states.
 */
export async function requestIdentity(event: H3Event): Promise<CommitIdentity> {
  const authorization = getHeader(event, 'authorization')
  if (authorization && /^Bearer /i.test(authorization)) {
    return { token: authorization.replace(/^Bearer\s+/i, '') }
  }
  const actor = await resolveActor(event)
  return actor.uid ? { uid: actor.uid, user: actor.name ?? undefined } : {}
}

export type CheckpointOutcome =
  | { blocked: false }
  | { blocked: true, statusCode: number, message: string, data?: Record<string, unknown> }

/**
 * Commits whatever a live session holds, so the moderation action that follows
 * acts on content Drupal has actually seen.
 *
 * No live document is not a problem — a page nobody is editing has nothing
 * pending, and the working copy in Drupal is already the whole truth. A
 * document that is loaded but whose commit *fails* is: publishing or reverting
 * over unwritten edits loses them without ever telling the user, so the
 * outcomes that mean "there are edits I could not write" block the action.
 *
 * It runs the one checkpoint path (`useCheckpoint`), not a commit of its own.
 * Approve is where that matters most: the peer pressing it would otherwise be
 * credited for everybody's typing — the checkpoint path states the window with
 * the text, so the co-authors reach the four-eyes baseline in the same write,
 * before the sign-off is judged. A commit assembled here would not have it.
 */
export async function checkpointLiveDocument(
  hp: Pick<Hocuspocus, 'documents'>,
  docName: string,
  event: H3Event,
): Promise<CheckpointOutcome> {
  if (!hp.documents.get(docName)) return { blocked: false }

  const result = await useCheckpoint()(docName, 'manual', await requestIdentity(event))

  switch (result.outcome) {
    case 'committed':
    case 'clean':
    case 'no-document':
    // `empty-body` is a document caught mid-flight — cleared for a reseed, or
    // lingering in the map while its unload drains. By definition it holds no
    // edit any client typed (the commit itself refuses to write empty over
    // content), so there is nothing the action could lose: Drupal's working
    // copy is the whole truth, exactly as with no document at all.
    case 'empty-body':
      return { blocked: false }
    case 'conflict':
      return {
        blocked: true,
        statusCode: 409,
        message: 'External change detected — reload before publishing.',
        data: { expected: result.expected, actual: result.changed },
      }
    case 'invalid':
      return {
        blocked: true,
        statusCode: 422,
        message: result.message ?? 'Validation failed',
        ...(result.fields ? { data: { fields: result.fields } } : {}),
      }
    case 'no-credentials':
      return {
        blocked: true,
        statusCode: 503,
        message: 'The collaboration server has no Drupal credential — run scripts/setup-collab-oauth.sh.',
      }
    default:
      return { blocked: true, statusCode: 502, message: result.message ?? 'Could not save pending changes' }
  }
}

/**
 * Core wraps an entity-level violation in `Entity is not valid: ` before it
 * leaves JSON:API. The user reads the description, so drop the envelope.
 */
function productSentence(detail: string) {
  const envelope = 'Entity is not valid: '
  return detail.startsWith(envelope) ? detail.slice(envelope.length) : detail
}

/**
 * Drupal's rejection of a moderation write, as an HTTP error. 422 is the
 * content (blocks waiting, or text outside identified blocks) and keeps
 * Drupal's sentence; 403 is the person; 409 a stale revert with its two
 * timestamps.
 */
export function moderationWriteError(err: unknown, fallback: string) {
  const e = err as {
    statusCode?: number
    data?: {
      drupalStatus?: number
      violations?: Violation[]
      conflict?: { expected: number, actual: number }
    }
    message?: string
  }
  const status = e?.data?.drupalStatus ?? e?.statusCode
  if (status === 409 && e?.data?.conflict) {
    return createError({
      statusCode: 409,
      statusMessage: 'External change detected — reload before reverting.',
      data: { expected: e.data.conflict.expected, actual: e.data.conflict.actual },
    })
  }
  const violations = e?.data?.violations ?? []
  const blockers = violations.filter(v => v.meta?.item)
  if (blockers.length > 0) {
    return createError({
      statusCode: 422,
      statusMessage: `${blockers.length} change(s) still need a review.`,
      data: { violations: blockers },
    })
  }
  if (status === 422) {
    const detail = violations.find(v => v.detail)?.detail
    return createError({
      statusCode: 422,
      statusMessage: detail ? productSentence(detail) : fallback,
      data: { violations },
    })
  }
  if (status === 403) {
    return createError({
      statusCode: 403,
      statusMessage: 'You do not have permission to make this change.',
    })
  }
  return createError({ statusCode: 502, statusMessage: e?.message ?? fallback })
}
