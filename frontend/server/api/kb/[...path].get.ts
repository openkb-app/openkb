import { defineEventHandler, getRouterParam, createError } from 'h3'
import { findKbPageByPath } from '../../utils/drupal'
import { getKbPage } from '../../utils/kb-read'

/**
 * GET /api/kb/<space>/<slug>(.md) and /api/kb/<space>/<slug>/draft.md
 *
 * One catch-all, because a page's address is its multi-segment space-scoped
 * path now (`team-wiki/getting-started`) — a single `[slug]` param cannot carry
 * the slash. It serves three shapes off that path:
 *
 *  - `<path>/draft.md` → the working copy (the draft the editing surfaces
 *    write): same projection as the published `.md`, a different revision.
 *    An account that may not write the page is refused with a 403 — the
 *    address is for the surfaces that edit. An editor whose page carries
 *    no forward draft reads the published body here, which is what their
 *    write would start from.
 *  - `<path>.md` → the *published* comark body with a YAML frontmatter
 *    projection above it (text/markdown), the same projection Drupal's
 *    `tool_api__get_page` tool serves. Draft writes are invisible here by design.
 *  - `<path>` (no suffix) → a small JSON view of the published page.
 *
 * The draft suffix is told apart from a page literally slugged `draft` by
 * requiring a slash to survive the strip: a real draft path
 * `<space>/<slug>/draft.md` leaves `<space>/<slug>`, while `<space>/draft.md`
 * (the page `draft`'s published `.md`) leaves the bare space and falls
 * through to the published branch.
 */
export default defineEventHandler(async (event) => {
  const path = getRouterParam(event, 'path')
  if (!path) throw createError({ statusCode: 400, statusMessage: 'Missing path' })

  const draftStem = path.replace(/\/draft\.md$/, '')
  if (draftStem !== path && draftStem.includes('/')) {
    const page = await getKbPage(event, draftStem, { version: 'working-copy' })
    if (!page) throw createError({ statusCode: 404, statusMessage: 'Page not found' })
    event.node.res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
    // Names the revision this body came from, so a caller reading both
    // addresses can tell them apart without comparing content.
    event.node.res.setHeader('X-OpenKB-Revision', 'working-copy')
    return page.markdown
  }

  if (path.endsWith('.md')) {
    const page = await getKbPage(event, path)
    if (!page) throw createError({ statusCode: 404, statusMessage: 'Page not found' })
    event.node.res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
    return page.markdown
  }

  const page = await findKbPageByPath(event, path)
  if (!page) throw createError({ statusCode: 404, statusMessage: 'Page not found' })
  return {
    path: page.path,
    title: page.title,
    body: page.body,
  }
})
