import type { H3Event } from 'h3'
import { createError, getHeader } from 'h3'
import { findKbPageByPath } from './drupal'
import { useAgentRouter } from './hocuspocus'
import {
  AgentOpsError,
  joinAgentSession,
  routeAgentEdit,
  type AgentEditResult,
  type JoinedAgentSession,
  type WriteCarrier,
  type WriteSubject,
} from './session-router'
import { StaleBlockError, type AgentOps } from './agent-peer'
import { decodePageEntities, encodePageEntities } from './comark-entities'
import { encodeDataImageUris } from './comark-data-uri'
import { fenceErrors } from './fences'

/**
 * The MCP write tools' front door to the session router: the Bearer token
 * that authorizes the request, how a target is named, and the entity and
 * fence checks every write passes.
 */

/**
 * The Bearer token a request writes under, if it presented one.
 *
 * Browser cookies riding along on the same host are ignored: honoring one
 * would let a session's wider permissions mask the token's scope ceiling.
 */
function writeCarrier(event: H3Event): WriteCarrier {
  const token = /^Bearer (.+)$/i.exec(getHeader(event, 'authorization') ?? '')?.[1]
  return token ? { token } : {}
}

/** How a write names its target: by node id, or by space-scoped path. */
export interface WriteTarget {
  nid?: number | string
  path?: string
}

/**
 * Resolves the target node from `nid` or `path`, keeping the name the caller
 * used so a refusal can answer in the caller's own terms.
 *
 * The path lookup runs under the request's own carrier, so a caller that may
 * not read the page cannot use a write surface to discover its nid — the
 * resolver enforces view access, and the join gate would refuse it anyway one
 * step later.
 */
export async function resolveWriteSubject(event: H3Event, target: WriteTarget): Promise<WriteSubject> {
  if (target.nid !== undefined) {
    const nid = Number(target.nid)
    if (!Number.isInteger(nid) || nid <= 0) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid "nid".' })
    }
    return { nid, name: `node ${nid}` }
  }
  if (typeof target.path === 'string' && target.path !== '') {
    // As tool_api__search_pages answers it: anchored on the cited section.
    const path = target.path.replace(/#.*$/, '').replace(/\.md$/, '')
    const page = await findKbPageByPath(event, path)
    if (!page) throw createError({ statusCode: 404, statusMessage: 'Page not found' })
    return { nid: page.nid, name: path }
  }
  throw createError({ statusCode: 400, statusMessage: 'Pass "nid" or "path".' })
}

/**
 * Puts the request in the page's session without writing anything — what a
 * watcher (`waitForChanges`) needs, admitted by the same gate as a write.
 */
export async function joinWriteSession(event: H3Event, subject: WriteSubject): Promise<JoinedAgentSession> {
  return joinAgentSession(useAgentRouter(), writeCarrier(event), subject)
}

/**
 * Applies ops through the session router under the request's own carrier.
 *
 * Every write surface passes here, so the entity boundary is here too, in both
 * directions (ADR 0014): what a model wrote as characters becomes markdown the
 * parser reads as its text, and the markdown a conflict hands back for the
 * retry comes home as characters.
 *
 * A fence component's source that does not parse is refused here too, before
 * anything is written: an agent hears the line and column to fix.
 */
export async function routeWrite(
  event: H3Event,
  subject: WriteSubject,
  ops: AgentOps,
): Promise<AgentEditResult> {
  const encoded = encodeContent(ops)
  await refuseInvalidFences(encoded)
  try {
    return await routeAgentEdit(useAgentRouter(), writeCarrier(event), subject, encoded)
  }
  catch (err) {
    if (err instanceof StaleBlockError) throw decodeConflicts(err)
    throw err
  }
}

/** Per-op messages for every refused fence component, as `blocks[i]`. */
async function refuseInvalidFences(ops: AgentOps): Promise<void> {
  const errors: Record<string, string[]> = {}
  for (const [i, op] of (ops.blocks ?? []).entries()) {
    const messages = await fenceErrors(op.markdown)
    if (messages.length > 0) errors[`blocks[${i}]`] = messages
  }
  if (Object.keys(errors).length > 0) throw new AgentOpsError(errors)
}

/** A conflict is re-applied by whoever reads it, so it crosses as text. */
function decodeConflicts(err: StaleBlockError): StaleBlockError {
  return new StaleBlockError(
    err.conflicts.map(c => ({ ...c, markdown: decodePageEntities(c.markdown) })),
  )
}

/**
 * Encodes the ops that carry page markdown. Field values and comment text
 * never meet the markdown parser, so they stay as they came.
 */
function encodeContent(ops: AgentOps): AgentOps {
  return {
    ...ops,
    ...(ops.blocks === undefined
      ? {}
      : { blocks: ops.blocks.map(op => ({ ...op, markdown: encodeWritten(op.markdown) })) }),
  }
}

/**
 * One passage of page markdown, as it is stored. The `data:` pass runs
 * before the entity boundary, so a `<svg` inside a URI is encoded as URI.
 */
function encodeWritten(markdown: string): string {
  return encodePageEntities(encodeDataImageUris(markdown))
}
