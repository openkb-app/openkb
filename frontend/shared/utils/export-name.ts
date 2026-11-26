/**
 * The file name a page export downloads as: the last segment of the page's
 * path, `page` without one, then the extension.
 */
export function pageExportFileName(pagePath: string, extension: 'md' | 'html'): string {
  const slug = pagePath.split('/').pop() || 'page'
  return `${slug.replace(/[^\w.-]/g, '-')}.${extension}`
}
