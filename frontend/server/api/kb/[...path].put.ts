import {
  defineEventHandler,
  getRouterParam,
  readRawBody,
  createError,
} from 'h3'
import {
  authenticateWrite,
  frontmatterFieldErrors,
  markdownOps,
  resolveWriteSubject,
  routeWrite,
  writeCarrier,
} from '../../utils/agent-write'
import { FrontmatterError } from '../../utils/frontmatter'
import { AgentJoinError, AgentOpsError } from '../../utils/session-router'

/**
 * PUT /api/kb/<space>/<slug>/draft.md  (text/markdown)
 *
 * The write side of the `.md` wire format, under an agent's Bearer token. A
 * whole document on an existing page is refused (use `updateBlocks`),
 * because replacing every block is a claim about work that is not the
 * writer's. Humans edit in the collaborative editor, not here.
 *
 * It replaces the **draft**, and it is addressed as the draft. Every write here
 * lands as a forward revision — `kb_page` is moderated (OKB-64) and no write
 * surface publishes — so a PUT on the published address would promise a
 * replacement it does not perform: the next `GET …/<slug>.md` would still serve
 * the old content, which is what RFC 9110 forbids of PUT. Addressing the draft
 * makes the pair honest instead: `GET …/<slug>/draft.md` returns exactly what
 * was written here. Making that content live is a separate, deliberate
 * transition (the publish action), not a side effect of a write.
 *
 * Only the `…/draft.md` address is writable — a PUT to any other path under
 * `/api/kb` is a 404, since there is no published resource to replace.
 *
 * The body is split from the YAML frontmatter; the frontmatter is parsed and
 * validated against the exposure contract (`GET /openkb/schema`). An
 * unknown/unexposed key or a value of the wrong shape for its field is a **422**
 * with per-field messages (OKB-44 taxonomy) — the exposure contract is the only
 * accepted surface, so a key it does not carry cannot be written by convention.
 *
 * The write itself goes through the session router
 * (server/utils/session-router.ts), the same path the MCP write tools and
 * `POST /api/agent/edit` take: validate → join the document's live session (or
 * start a headless one) → apply as CRDT ops. The session owns persistence, so a
 * 200 says the session took the write, not that Drupal stored it — read it back
 * with `GET …/draft.md`, which serves the live session.
 */
export default defineEventHandler(async (event) => {
  const path = getRouterParam(event, 'path')
  const pagePath = path?.replace(/\/draft\.md$/, '')
  if (!path || !pagePath || pagePath === path || !pagePath.includes('/')) {
    throw createError({ statusCode: 404, statusMessage: 'Only <space>/<slug>/draft.md is writable' })
  }

  if (!writeCarrier(event).token) {
    throw createError({ statusCode: 401, statusMessage: 'Bearer token required' })
  }

  let actor
  try {
    actor = await authenticateWrite(event)
  }
  catch (err) {
    throw writeErrorToHttp(err)
  }

  const raw = (await readRawBody(event, 'utf8')) ?? ''
  const subject = await resolveWriteSubject(event, { path: pagePath })

  try {
    const ops = await markdownOps(event, raw)
    const result = await routeWrite(event, subject, ops, actor)
    return { path: pagePath, ok: true, entry: result.entry, observers: result.observers, fields: ops.fields ?? {} }
  }
  catch (err) {
    throw writeErrorToHttp(err)
  }
})

/** Maps the write path's refusals onto the HTTP taxonomy. */
function writeErrorToHttp(err: unknown): unknown {
  if (err instanceof FrontmatterError) {
    return createError({
      statusCode: 422,
      statusMessage: err.message,
      data: { keys: err.keys, fields: frontmatterFieldErrors(err) },
    })
  }
  if (err instanceof AgentOpsError) {
    return createError({ statusCode: 422, statusMessage: err.message, data: { fields: err.fields } })
  }
  if (err instanceof AgentJoinError) {
    return createError({ statusCode: err.statusCode, statusMessage: err.message, data: { denial: err.denial } })
  }
  return err
}
