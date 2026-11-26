/**
 * The auth carrier of the page export's render of the read page
 * (server/utils/export-render.ts); empty for any other render.
 */
export function useExportRenderAuthHeaders(): Record<string, string> {
  if (!import.meta.server) {
    return {}
  }
  return (useRequestEvent()?.context.okbExportRenderAuth as Record<string, string> | undefined) ?? {}
}
