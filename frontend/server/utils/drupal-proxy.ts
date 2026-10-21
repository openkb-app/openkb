import type { H3Event } from 'h3'
import { proxyRequest, getRouterParam, getRequestURL, createError } from 'h3'
import { drupalBaseUrl } from './drupal'

/**
 * The router param as a path to append to a Drupal prefix: each segment fully
 * decoded, then percent-encoded, so `fetch` gets no tab, CR, LF, `#`, `?` or
 * `\` to strip or resolve. Undefined, i.e. refused:
 * - an empty, `.` or `..` segment; one trailing slash is fine
 * - a segment that decodes to one of those or holds a `/` or `\`
 */
export function drupalPath(param: string): string | undefined {
  const trailing = param.endsWith('/') ? '/' : ''
  const path = trailing ? param.slice(0, -1) : param
  if (path === '') return trailing ? undefined : ''
  const segments: string[] = []
  for (const segment of path.split('/')) {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    }
    catch {
      return undefined
    }
    if (/^\.{0,2}$/.test(decoded) || /[/\\]/.test(decoded)) return undefined
    segments.push(encodeURIComponent(decoded))
  }
  return segments.join('/') + trailing
}

/**
 * Proxies the request to `${base}/${prefix}/${path}${search}`, the path being
 * the route's `[...path]` param through {@link drupalPath}. 404 when that
 * refuses it. Cookies pass through, so Drupal sees the shared session.
 */
export function drupalPassthrough(event: H3Event, prefix: string) {
  const param = drupalPath(getRouterParam(event, 'path') ?? '')
  if (param === undefined) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }
  const path = param ? `${prefix}/${param}` : prefix
  return proxyRequest(event, `${drupalBaseUrl()}/${path}${getRequestURL(event).search}`)
}
