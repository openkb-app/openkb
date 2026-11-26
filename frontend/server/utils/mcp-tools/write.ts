import type { H3Event } from 'h3'
import { resolveWriteSubject, routeWrite } from '../agent-write'
import { AgentJoinError, AgentOpsError, type AgentEditResult } from '../session-router'
import { CommentRefusedError, DuplicatedBlockError, StaleBlockError, UnanchoredBlockError, UnchainedBlockError, UnknownBlockError, UnknownThreadError, UnlistedFileError, type AgentOps, type NotAcceptedFile } from '../agent-peer'
import { answered, refused, type ToolResult } from './types'

/**
 * The write tools' shared body: resolve the target, route the ops, report.
 *
 * It never throws — every refusal, including an unauthorized one, comes back
 * as a structured result. Nothing is decided here: the gate lives in the
 * router, which re-asks Drupal per call, and a denial's wording is Drupal's.
 */
export async function runWrite(
  event: H3Event,
  args: Record<string, unknown>,
  ops: AgentOps,
): Promise<ToolResult> {
  try {
    const subject = await resolveWriteSubject(event, {
      nid: args.nid as number | undefined,
      path: args.path as string | undefined,
    })
    return writeResult(await routeWrite(event, subject, ops))
  }
  catch (err) {
    return sessionRefusal(err)
  }
}

/**
 * A refused write: readable text plus the same refusal as validated structured
 * content, so an agent can react to the per-field messages without parsing
 * prose. Nothing was written.
 */
export function writeRefusal(message: string, errors: Record<string, string[]> = {}): ToolResult {
  const detail = Object.entries(errors)
    .map(([key, messages]) => `- ${key}: ${messages.join(' ')}`)
    .join('\n')
  return refused(
    detail ? `${message}\n${detail}` : message,
    { ok: false, message, ...(detail ? { errors } : {}) },
  )
}

/**
 * An applied write, reported in the shape WRITE_OUTPUT_SCHEMA declares.
 *
 * - A call whose replaced blocks all came out unchanged, with nothing else
 *   applied, is a refusal: an answer reading as success lets the model report
 *   a change it never made.
 * - Added files the session did not add are named with the way forward. Not
 *   an error; `ok` is false when nothing else was applied.
 */
/** What a commentOnBlock write did, for the answer's summary line. */
function describeComment(comment: { threadId: string, msgId?: string, resolved?: true }): string {
  if (!comment.msgId) {
    return `resolved thread ${comment.threadId}`
  }
  const resolved = comment.resolved ? ' (resolved)' : ''
  return `comment in thread ${comment.threadId}${resolved}`
}

function writeResult(result: AgentEditResult): ToolResult {
  const { unchanged, removed, notAccepted = [], ...rest } = result.applied
  const applied = { ...rest, ...(removed.length ? { removed } : {}) }
  const blocks = Object.entries(applied.blocks)
  const changed = [
    applied.fields.length ? `fields: ${applied.fields.join(', ')}` : null,
    blocks.length ? `blocks: ${blocks.map(([id, version]) => `${id}@${version}`).join(', ')}` : null,
    removed.length ? `removed blocks: ${removed.join(', ')}` : null,
    applied.comment ? describeComment(applied.comment) : null,
  ].filter(Boolean).join('; ')
  const notAcceptedNote = notAccepted.length ? ` ${describeNotAcceptedFiles(notAccepted)}` : ''
  if (!changed && notAccepted.length) {
    const message = `Nothing changed.${notAcceptedNote}`
    return answered(message, { ok: false, message, nid: result.nid, notAccepted, ...(unchanged.length ? { unchanged } : {}) })
  }
  if (!changed && unchanged.length) {
    const message = `Nothing changed: ${describeUnchangedBlocks(unchanged)}. If you meant to change it, send the changed markdown.`
    return refused(message, { ok: false, message, nid: result.nid, unchanged })
  }
  const data = {
    ok: true,
    nid: result.nid,
    entry: result.entry,
    observers: result.observers,
    applied,
    ...(unchanged.length ? { unchanged } : {}),
    ...(notAccepted.length ? { notAccepted } : {}),
  }
  const persisted = result.observers > 0
    ? `left to the live session (${result.observers} editor(s) connected)`
    : 'left to your open session, which persists it'
  const unchangedNote = unchanged.length ? ` Not changed: ${describeUnchangedBlocks(unchanged)}.` : ''
  return answered(`Updated node ${result.nid} — ${changed || 'nothing changed'}; ${persisted}.${unchangedNote}${notAcceptedNote}`, data)
}

/** Names the files not added, and how to add a file of one's own. */
function describeNotAcceptedFiles(files: NotAcceptedFile[]): string {
  const named = files.map(({ list, file }) => `${file} (${list})`).join(', ')
  return `Not accepted: ${named}. Only files you uploaded yourself may be added to a page, `
    + 'unless the page holds them now. Upload the file yourself with tool_api__file_upload_url '
    + 'or tool_api__upload_attachment, then add the UUID that upload answers.'
}

/** Names unchanged blocks: "block b-1 already holds exactly this markdown". */
function describeUnchangedBlocks(ids: string[]): string {
  return ids.length === 1
    ? `block ${ids[0]} already holds exactly this markdown`
    : `blocks ${ids.join(', ')} already hold exactly this markdown`
}

/**
 * A stale-write refusal: every refused op with the block's current markdown and
 * version beside it, so the retry needs no second read.
 */
function staleRefusal(err: StaleBlockError): ToolResult {
  const detail = err.conflicts
    .map(c => `- blocks[${c.index}] ${c.id}: expected ${c.expected}, now ${c.version}\n${c.markdown}`)
    .join('\n\n')
  return refused(
    `${err.message}\n\n${detail}`,
    { ok: false, message: err.message, conflicts: err.conflicts },
  )
}

/**
 * Maps everything the session path can refuse with onto a structured refusal.
 *
 * The join gate, the exposure contract and the transport-level problems (an
 * unknown path, an unreachable schema) all reach the agent as tool results,
 * never as protocol errors: a client that asked for a page that does not exist
 * has made an ordinary mistake and should be able to try again on the same
 * connection.
 */
export function sessionRefusal(err: unknown): ToolResult {
  if (err instanceof StaleBlockError) return staleRefusal(err)
  if (err instanceof UnknownBlockError || err instanceof DuplicatedBlockError || err instanceof UnknownThreadError || err instanceof CommentRefusedError || err instanceof UnanchoredBlockError || err instanceof UnchainedBlockError || err instanceof UnlistedFileError) {
    return writeRefusal(err.message)
  }
  if (err instanceof AgentOpsError) return writeRefusal('Validation failed — nothing was written.', err.fields)
  if (err instanceof AgentJoinError) return writeRefusal(err.message)
  const status = (err as { statusCode?: number }).statusCode
  const statusMessage = (err as { statusMessage?: string }).statusMessage
  if (status) return writeRefusal(statusMessage ?? `Write refused (${status}).`)
  return writeRefusal(`Write failed: ${(err as Error).message}`)
}
