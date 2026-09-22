import { defineEventHandler, getRouterParams, getQuery, getHeader, readRawBody, createError } from 'h3'
import { drupalBaseUrl } from '../../utils/drupal'
import { forwardedAuthHeaders } from '../../utils/actor'
import { fetchUpstream, relaySetCookie, upstreamError } from '../../utils/upstream'

/**
 * Forwards the allowlisted Drupal API prefixes under the caller's own session
 * or token, JSON only, writes under Drupal's CSRF token; `/api/drupal-ce` does
 * the same for CE pages. No logic here.
 */

/** The Drupal API prefixes this route forwards. */
const FORWARDED_PREFIXES = ['openkb/']

/** JSON and JSON:API, with any parameters the media type carries. */
const JSON_TYPE = /^application\/(?:json|vnd\.api\+json)\s*(?:;|$)/i

/** Whether a media-type header names JSON. `*_/_*` does not count. */
function isJson(header: string | undefined): boolean {
  return !!header && header.split(',').some(type => JSON_TYPE.test(type.trim()))
}

/**
 * Whether the path is one this route serves. A `..` segment is refused rather
 * than resolved: `openkb/../user/1` passes any prefix test and reaches Drupal
 * as `/user/1`.
 */
function forwardable(path: string): boolean {
  return !path.split('/').includes('..')
    && FORWARDED_PREFIXES.some(prefix => path.startsWith(prefix))
}

export default defineEventHandler(async (event) => {
  const params = getRouterParams(event).path ?? ''
  const path = Array.isArray(params) ? params.join('/') : params
  if (!forwardable(path)) {
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
  const csrf = getHeader(event, 'x-csrf-token')
  const reads = method === 'GET' || method === 'HEAD'
  if (!reads && !csrf) {
    throw createError({ statusCode: 403, statusMessage: 'A write needs a CSRF token' })
  }

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
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      ...auth,
    },
    body,
  })
  relaySetCookie(event, res)
  if (!res.ok) throw await upstreamError(res, `drupal ${method} /${path}`)

  const answered = res.headers.get('content-type')
  if (!isJson(answered ?? undefined)) {
    console.error(`[upstream] drupal ${method} /${path} answered ${answered ?? 'no content type'}`)
    throw createError({ statusCode: 502, statusMessage: 'Upstream did not answer JSON' })
  }
  return res.json()
})
