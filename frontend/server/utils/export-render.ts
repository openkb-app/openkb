import { randomUUID, timingSafeEqual } from 'node:crypto'
import { getHeader, type H3Event } from 'h3'
import { forwardedAuthHeaders } from './actor'

/**
 * The page export's own render of the read page (server/utils/page-export.ts).
 *
 * - A header only this process knows marks it.
 * - It is a print render (`event.context.okbPrintRender`, usePrintRender()).
 * - It is the one SSR pass a Bearer token may make: its auth carrier lands on
 *   `event.context.okbExportRenderAuth` for the page fetch and the auth guard.
 */

/** The header that marks the export's render. */
export const EXPORT_RENDER_HEADER = 'x-okb-export-render'

/** This process's mark; an outside request cannot know it. */
const EXPORT_RENDER_MARK = Buffer.from(randomUUID())

/**
 * The header that marks the export's render of the read page.
 *
 * `event.fetch` forwards the caller's own headers, its auth carrier included.
 */
export function exportRenderHeaders(): Record<string, string> {
  return { [EXPORT_RENDER_HEADER]: EXPORT_RENDER_MARK.toString() }
}

/**
 * Marks the export's render on the request context: a print render, with its
 * auth carrier.
 *
 * The mark header is removed from every request, so nothing forwards it.
 */
export function markExportRender(event: H3Event): void {
  const mark = getHeader(event, EXPORT_RENDER_HEADER)
  if (mark === undefined) {
    return
  }
  delete event.node.req.headers[EXPORT_RENDER_HEADER]
  if (isExportRenderMark(mark)) {
    event.context.okbPrintRender = true
    event.context.okbExportRenderAuth = forwardedAuthHeaders(event)
  }
}

/** Whether a header value is this process's mark. */
function isExportRenderMark(value: string): boolean {
  const given = Buffer.from(value)
  return given.length === EXPORT_RENDER_MARK.length && timingSafeEqual(given, EXPORT_RENDER_MARK)
}
