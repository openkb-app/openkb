import { defineEventHandler, getRouterParams, getQuery } from 'h3'
import { drupalBaseUrl } from '../../utils/drupal'
import { fetchUpstream, relaySetCookie, upstreamError } from '../../utils/upstream'
import { enrichCePage, type CePage } from '../../utils/drupal-ce-enrich'
import { bodyAllowedHtml } from '../../utils/comark-allowed-html'
import { forwardedAuthHeaders } from '../../utils/actor'

/**
 * Overrides nuxtjs-drupal-ce's built-in /api/drupal-ce/** passthrough.
 *
 * The Drupal CE-API ships kb_page bodies as raw markdown on
 * `content.props.body` (markdown_raw formatter, custom_elements.entity_ce_display).
 * This handler proxies the CE-API and runs the comark tree passes over that
 * markdown to produce `content.props.bodyTree`. One round-trip to Drupal, one
 * parser, one source of truth.
 *
 * Transformation lives in `enrichCePage` so it can be unit-tested without
 * a Nuxt runtime.
 */
export default defineEventHandler(async (event) => {
  const params = getRouterParams(event).path ?? ''
  const path = params ? '/' + (Array.isArray(params) ? params.join('/') : params) : ''
  const qs = new URLSearchParams(getQuery(event) as Record<string, string>).toString()
  const url = `${drupalBaseUrl()}/ce-api${path}${qs ? '?' + qs : ''}`

  const auth = forwardedAuthHeaders(event)
  const res = await fetchUpstream(url, { headers: { Accept: 'application/json', ...auth } })
  relaySetCookie(event, res)
  if (!res.ok) throw await upstreamError(res, `CE-API ${path}`)
  const page = (await res.json()) as CePage
  return enrichCePage(page, auth, await bodyAllowedHtml())
})
