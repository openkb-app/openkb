import { createError, defineEventHandler, readBody } from 'h3'
import { authenticateWrite, resolveWriteSubject, routeWrite, writeCarrier } from '../../utils/agent-write'
import { AgentJoinError, AgentOpsError } from '../../utils/session-router'
import { readBlockOpList, StaleBlockError, UnanchoredBlockError, UnchainedBlockError, type BlockOp } from '../../utils/agent-peer'
import type { FieldValues } from '../../utils/entity-fields'

/**
 * POST /api/agent/edit — the HTTP face of the session router.
 *
 * Body: `{ nid | path, fields?, blocks? }`. The agent joins the document's live
 * collaborative session (or starts a headless one) and applies the ops as CRDT
 * ops. The session owns persistence, so a 200 says the session took the write,
 * not that Drupal stored it. See server/utils/session-router.ts.
 *
 * `blocks` is how an existing page is edited: each op names the block it
 * replaces or inserts beside. A whole `body` is refused — see
 * refuseWholeBody() in the session router.
 *
 * Bearer-only, and the token is the *only* thing that authorizes: a browser
 * cookie riding along on the same host is ignored, because an agent request
 * must never be able to borrow a session's wider permissions.
 *
 * **Auth first.** The token is authenticated before the payload is looked at,
 * so bad credentials plus a malformed body is a 401 — the caller's real
 * problem — and an unauthenticated caller learns nothing about the request
 * shape. Only the per-node access check waits for the payload, because it
 * needs the target.
 *
 * This is the router's transport, not its only caller — the `updateFields` /
 * `updateBlocks` MCP tools and the `.md` PUT route the same way, so every write
 * surface shares one validate → session → commit path. The endpoint stays as
 * the scriptable way to drive an agent edit without an MCP client.
 */
export default defineEventHandler(async (event) => {
  if (!writeCarrier(event).token) {
    throw createError({ statusCode: 401, statusMessage: 'Bearer token required' })
  }

  let actor
  try {
    actor = await authenticateWrite(event)
  }
  catch (err) {
    throw joinErrorToHttp(err)
  }

  const body = await readBody(event) as {
    nid?: number | string
    path?: string
    fields?: FieldValues
    body?: string
    blocks?: BlockOp[]
  } | null

  if (body?.fields !== undefined && (typeof body.fields !== 'object' || body.fields === null || Array.isArray(body.fields))) {
    throw createError({ statusCode: 400, statusMessage: '"fields" must be an object.' })
  }
  if (body?.body !== undefined && typeof body.body !== 'string') {
    throw createError({ statusCode: 400, statusMessage: '"body" must be a markdown string.' })
  }
  let blocks: BlockOp[] | undefined
  if (body?.blocks !== undefined) {
    const read = readBlockOpList(body.blocks)
    if ('fault' in read) throw createError({ statusCode: 400, statusMessage: read.fault })
    blocks = read.ops
  }
  if (body?.fields === undefined && body?.body === undefined && body?.blocks === undefined) {
    throw createError({ statusCode: 400, statusMessage: 'Nothing to apply — pass "fields" and/or "blocks".' })
  }

  const subject = await resolveWriteSubject(event, { nid: body?.nid, path: body?.path })

  try {
    return await routeWrite(event, subject, { fields: body?.fields, body: body?.body, blocks }, actor)
  }
  catch (err) {
    throw joinErrorToHttp(err)
  }
})

/** Maps the router's refusals onto the HTTP taxonomy; rethrows anything else. */
function joinErrorToHttp(err: unknown): unknown {
  if (err instanceof AgentJoinError) {
    return createError({ statusCode: err.statusCode, statusMessage: err.message, data: { denial: err.denial } })
  }
  if (err instanceof AgentOpsError) {
    // Per-field messages in the same shape the commit RPC and the `.md` PUT
    // report, so one client-side error renderer covers every write surface.
    return createError({ statusCode: 422, statusMessage: err.message, data: { fields: err.fields } })
  }
  if (err instanceof UnanchoredBlockError || err instanceof UnchainedBlockError) {
    // The payload is malformed for this document — the same 400 the shape
    // checks answer, only the document could tell.
    return createError({ statusCode: 400, statusMessage: err.message })
  }
  if (err instanceof StaleBlockError) {
    // 409, not 422: the payload is well-formed and the caller's own retry —
    // against the markdown each conflict carries — is what resolves it.
    return createError({ statusCode: 409, statusMessage: err.message, data: { conflicts: err.conflicts } })
  }
  return err
}
