import type { H3Event } from 'h3'
import { resolveWriteSubject, routeWrite } from '../agent-write'
import { AgentJoinError, AgentOpsError, type AgentEditResult } from '../session-router'
import { StaleBlockError, UnanchoredBlockError, UnchainedBlockError, UnknownBlockError, UnknownThreadError, type AgentOps } from '../agent-peer'
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

/** An applied write, reported in the shape WRITE_OUTPUT_SCHEMA declares. */
function writeResult(result: AgentEditResult): ToolResult {
  const data = {
    ok: true,
    nid: result.nid,
    entry: result.entry,
    observers: result.observers,
    applied: result.applied,
  }
  const blocks = Object.entries(result.applied.blocks)
  const changed = [
    result.applied.fields.length ? `fields: ${result.applied.fields.join(', ')}` : null,
    result.applied.body ? 'body' : null,
    blocks.length ? `blocks: ${blocks.map(([id, version]) => `${id}@${version}`).join(', ')}` : null,
    result.applied.comment ? `comment in thread ${result.applied.comment.threadId}` : null,
  ].filter(Boolean).join('; ') || 'nothing changed'
  const persisted = result.observers > 0
    ? `left to the live session (${result.observers} editor(s) connected)`
    : 'left to your open session, which persists it'
  return answered(`Updated node ${result.nid} — ${changed}; ${persisted}.`, data)
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
  if (err instanceof UnknownBlockError || err instanceof UnknownThreadError || err instanceof UnanchoredBlockError || err instanceof UnchainedBlockError) {
    return writeRefusal(err.message)
  }
  if (err instanceof AgentOpsError) return writeRefusal('Validation failed — nothing was written.', err.fields)
  if (err instanceof AgentJoinError) return writeRefusal(err.message)
  const status = (err as { statusCode?: number }).statusCode
  const statusMessage = (err as { statusMessage?: string }).statusMessage
  if (status) return writeRefusal(statusMessage ?? `Write refused (${status}).`)
  return writeRefusal(`Write failed: ${(err as Error).message}`)
}
