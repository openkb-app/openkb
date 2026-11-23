import { defineEventHandler, getRouterParams, getQuery, getHeader, readRawBody, createError } from 'h3'
import { drupalBaseUrl } from '../../utils/drupal'
import { forwardedAuthHeaders } from '../../utils/actor'
import { fetchUpstream, relaySetCookie, upstreamError } from '../../utils/upstream'
import { drupalPath } from '../../utils/drupal-proxy'

/**
 * Forwards the allowlisted Drupal API paths under the caller's own session
 * or token, JSON only, with the caller's own CSRF token (ADR 0019);
 * `/api/drupal-ce` does the same for CE pages. No logic here.
 */

/**
 * The Drupal API paths this route forwards:
 * - everything under `openkb/`
 * - the invite collection and single invites, not their relationship routes
 */
const FORWARDED_PATHS = [
  /^openkb\//,
  /^jsonapi\/openkb_invite\/openkb_invite(?:\/[0-9a-f-]+)?$/,
]

/** JSON and JSON:API, with any parameters the media type carries. */
const JSON_TYPE = /^application\/(?:json|vnd\.api\+json)\s*(?:;|$)/i

/** Whether a media-type header names JSON. `*_/_*` does not count. */
function isJson(header: string | undefined): boolean {
  return !!header && header.split(',').some(type => JSON_TYPE.test(type.trim()))
}

/**
 * The path to forward, if this route serves it: an allowlisted one,
 * through {@link drupalPath}, which refuses dot segments rather than resolving
 * them — `openkb/../user/1` passes any prefix test and reaches Drupal as
 * `/user/1`.
 */
function forwardable(param: string): string | undefined {
  const path = drupalPath(param)
  return path !== undefined && FORWARDED_PATHS.some(allowed => allowed.test(path)) ? path : undefined
}

export default defineEventHandler(async (event) => {
  const params = getRouterParams(event).path ?? ''
  const path = forwardable(Array.isArray(params) ? params.join('/') : params)
  if (path === undefined) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }

  const auth = forwardedAuthHeaders(event)
  if (Object.keys(auth).length === 0) {
    throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
  }
  if (!isJson(getHeader(event, 'accept'))) {
    throw createError({ statusCode: 406, statusMessage: 'This route answers JSON only' })
  }

  const method = event.method
  const reads = method === 'GET' || method === 'HEAD'

  const contentType = getHeader(event, 'content-type')
  const body = reads ? undefined : await readRawBody(event)
  if (body !== undefined && !isJson(contentType)) {
    throw createError({ statusCode: 415, statusMessage: 'This route accepts JSON only' })
  }

  const qs = new URLSearchParams(getQuery(event) as Record<string, string>).toString()
  const res = await fetchUpstream(`${drupalBaseUrl()}/${path}${qs ? '?' + qs : ''}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined && contentType ? { 'Content-Type': contentType } : {}),
      ...auth,
    },
    body,
  })
  relaySetCookie(event, res)
  if (!res.ok) throw await upstreamError(res, `drupal ${method} /${path}`)
  // A delete answers with no body; null passes the 204 on.
  if (res.status === 204) return null

  const answered = res.headers.get('content-type')
  if (!isJson(answered ?? undefined)) {
    console.error(`[upstream] drupal ${method} /${path} answered ${answered ?? 'no content type'}`)
    throw createError({ statusCode: 502, statusMessage: 'Upstream did not answer JSON' })
  }
  return res.json()
})
