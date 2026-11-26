import { createError, getRequestURL, setResponseHeaders, type H3Event } from 'h3'
import { useNitroApp } from 'nitropack/runtime'
import { drupalBaseUrl, fetchCePage, publicDrupalBaseUrl } from './drupal'
import { forwardedAuthHeaders } from './actor'
import { exportRenderHeaders } from './export-render'
import { fetchUpstream } from './upstream'
import { buildPrintHtml, EXPORT_CSP } from './print-html'
import { pageExportFileName } from '#shared/utils/export-name'
import type { PageVersion } from './drupal'

/** How long the page files of one export may take to download, together. */
const FILES_TIMEOUT_MS = 60_000

/**
 * The print HTML of the page at `path` (OKB-541), as a download.
 *
 * Access is the `.md` route's: the published page for whoever may read it,
 * the working copy for whoever may edit it (403 otherwise). The page is the
 * read page as this server renders it for the caller.
 */
export async function exportPageHtml(event: H3Event, path: string, version: PageVersion): Promise<string> {
  const found = await fetchCePage(event, path)
  if (!found) {
    throw createError({ statusCode: 404, statusMessage: 'Page not found' })
  }
  if (version === 'working-copy' && !found.canEdit) {
    throw createError({ statusCode: 403, statusMessage: 'Not allowed to read the working copy' })
  }

  // A forward draft is read on its own route; without one the working copy is the page.
  let renderPath = found.page.path
  if (version === 'working-copy' && found.hasDraft) {
    renderPath = `/node/${found.page.nid}/latest`
  }
  const origin = getRequestURL(event).origin
  const filesDeadline = AbortSignal.timeout(FILES_TIMEOUT_MS)
  const html = await buildPrintHtml({
    html: await renderReadPage(event, renderPath),
    pageUrl: origin + found.page.path,
    fetchAsset: fetchOwnAsset,
    fetchFile: url => fetchPageFileAsReader(event, url, filesDeadline),
  })

  setResponseHeaders(event, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Disposition': `attachment; filename="${pageExportFileName(found.page.path, 'html')}"`,
    'Content-Security-Policy': EXPORT_CSP,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  return html
}

/** The read page at `path` as this server renders it for the caller. */
async function renderReadPage(event: H3Event, path: string): Promise<string> {
  const response = await event.fetch(path, {
    headers: { ...exportRenderHeaders(), Accept: 'text/html' },
    redirect: 'manual',
  })
  if (response.status !== 200) {
    console.error(`[page-export] render of the read page answered ${response.status}`)
    const refused = response.status === 403 || response.status === 404
    throw createError({ statusCode: refused ? response.status : 503, statusMessage: 'Page unavailable' })
  }
  return response.text()
}

/**
 * One of this app's stylesheets or fonts, fetched without the caller's
 * credentials.
 *
 * - Built server: in process, from Nitro's public assets.
 * - `nuxt dev`: over HTTP to this server; Vite serves them, outside Nitro.
 */
function fetchOwnAsset(path: string): Promise<Response> {
  const init = { headers: { 'Accept': 'text/css,*/*', 'Accept-Encoding': 'identity' } }
  if (!import.meta.dev) {
    return useNitroApp().localFetch(path, init)
  }
  const port = process.env.NITRO_PORT || process.env.NUXT_PORT || process.env.PORT || '3000'
  return fetch(`http://127.0.0.1:${port}${path}`, init)
}

/**
 * A page file from Drupal's private-file route, as the caller may download it;
 * null for any other URL, which the export never fetches.
 */
async function fetchPageFileAsReader(event: H3Event, url: string, deadline: AbortSignal): Promise<Response | null> {
  const prefix = `${publicDrupalBaseUrl()}/system/files/`
  if (!url.startsWith(prefix)) {
    return null
  }
  const path = url.slice(publicDrupalBaseUrl().length)
  return fetchUpstream(`${drupalBaseUrl()}${path}`, {
    headers: forwardedAuthHeaders(event),
    redirect: 'manual',
    signal: deadline,
  })
}
