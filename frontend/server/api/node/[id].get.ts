import { defineEventHandler, getRouterParam, getQuery, createError } from 'h3'
import { fetchCeNode, fetchCeWorkingCopy } from '../../utils/drupal'
import { forwardedAuthHeaders } from '../../utils/actor'
import { blockVersions } from '../../utils/block-versions'
import { bodyForms } from '../../utils/kb-read'

/**
 * Returns a page keyed by drupal_internal__nid. `body` is the comark
 * markdown below the title heading (server/utils/title-heading.ts) — the
 * editor parses it straight to ProseMirror JSON via the shared markdown
 * engine (app/comark/markdown-engine.ts).
 *
 * This is the editor's hydration source, so it serves the working copy: on a
 * Published page carrying a forward draft (OKB-64) the draft is the text
 * being worked on, and the `changed` returned here is the token the editor
 * commits against. Public read pages go through the CE pipeline and keep
 * serving the published default revision.
 *
 * `?version=default` asks for the live revision instead — one request, for a
 * caller that only wants revision-independent data (the /node/<id>/edit
 * redirect needs the path alias and nothing else).
 *
 * `versions` rides along — block id => the block's version, derived off the
 * canonical body exactly as a `.md` read derives it
 * (server/utils/block-versions.ts). It is what the citation picker stores on a
 * `:citation` node, so a citation is made against a version the server computed.
 *
 * Drupal's refusal is the answer: 403 for a page this account may not
 * read, 404 where the space hides it.
 */
export default defineEventHandler(async (event) => {
  const idParam = getRouterParam(event, 'id')
  const nid = Number(idParam)
  if (!nid || !Number.isFinite(nid)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid node id' })
  }
  const auth = forwardedAuthHeaders(event)
  const read = getQuery(event).version === 'default'
    ? await fetchCeNode(auth, nid)
    : await fetchCeWorkingCopy(auth, nid)
  return { ...read.page, versions: blockVersions(bodyForms(read.page.body).canonical) }
})
