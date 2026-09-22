import type { H3Event } from 'h3'
import { createError, getHeader } from 'h3'
import { fetchFrontmatterSpecs, findKbPageByPath } from './drupal'
import { useAgentRouter } from './hocuspocus'
import { FrontmatterError, parseFields, splitFrontmatter } from './frontmatter'
import {
  authenticateWriter,
  joinAgentSession,
  routeAgentEdit,
  type AgentEditResult,
  type JoinedAgentSession,
  type WriteCarrier,
  type WriteSubject,
} from './session-router'
import { StaleBlockError, type AgentActor, type AgentOps } from './agent-peer'
import { decodePageEntities, encodePageEntities } from './comark-entities'
import { encodeDataImageUris } from './comark-data-uri'
import type { FieldValues } from './entity-fields'

/**
 * The write surfaces' shared front door to the session router.
 *
 * Three transports reach the router — the `updateFields` / `updateBlocks` MCP
 * tools,
 * `POST /api/agent/edit`, and the draft `.md` PUT — and they must not each grow
 * their own idea of what a write request is. Everything they have in common lives
 * here: the Bearer token that authorizes the request, how a target is named,
 * what a `.md` document means as ops. What stays in each transport is only how a
 * refusal is *reported* (HTTP status vs MCP tool result).
 */

/**
 * The Bearer token a request writes under, if it presented one.
 *
 * Browser cookies riding along on the same host are ignored: honoring one
 * would let a session's wider permissions mask the token's scope ceiling.
 */
export function writeCarrier(event: H3Event): WriteCarrier {
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
 * Reads a `.md` document as session ops: the YAML frontmatter becomes field
 * values, the remainder becomes the body.
 *
 * Parsing is the wire format's own codec (server/utils/frontmatter.ts) — the
 * same one the `.md` GET projects with — so the `.md` PUT accepts exactly what
 * the `.md` GET serves. A document with no frontmatter block writes the body
 * only; it does not blank the fields.
 */
export async function markdownOps(event: H3Event, raw: string): Promise<AgentOps> {
  const { frontmatter, body } = splitFrontmatter(raw)
  if (frontmatter === null) return { body }
  const specs = await fetchFrontmatterSpecs(event)
  const fields: FieldValues = parseFields(specs, frontmatter)
  return { fields, body }
}

/**
 * Authenticates the request's carrier before anything else runs.
 *
 * Every write transport calls this first — a caller with bad credentials hears
 * about the credentials, not about their payload (401 before 400). The actor
 * is handed to {@link routeWrite}, which still asks Drupal about this node.
 */
export async function authenticateWrite(event: H3Event): Promise<AgentActor> {
  return authenticateWriter(useAgentRouter(), writeCarrier(event))
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
 */
export async function routeWrite(
  event: H3Event,
  subject: WriteSubject,
  ops: AgentOps,
  authenticated?: AgentActor,
): Promise<AgentEditResult> {
  try {
    return await routeAgentEdit(useAgentRouter(), writeCarrier(event), subject, encodeContent(ops), authenticated)
  }
  catch (err) {
    if (err instanceof StaleBlockError) throw decodeConflicts(err)
    throw err
  }
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
    ...(ops.body === undefined ? {} : { body: encodeWritten(ops.body) }),
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

/**
 * Maps a frontmatter parse failure onto the per-field shape every write
 * surface reports, so an unknown key reads the same whether it arrived as
 * `.md` frontmatter or as an `updateFields` object.
 */
export function frontmatterFieldErrors(err: FrontmatterError): Record<string, string[]> {
  if (err.keys.length === 0) return { frontmatter: [err.message] }
  return Object.fromEntries(err.keys.map(key => [key, [err.message]]))
}

