import { defineEventHandler, getQuery } from 'h3'
import { drupalBaseUrl } from '../../utils/drupal'
import { fetchUpstream, relaySetCookie, upstreamError } from '../../utils/upstream'
import { enrichCePage, type CePage } from '../../utils/drupal-ce-enrich'
import { bodyAllowedHtml } from '../../utils/comark-allowed-html'
import { forwardedAuthHeaders } from '../../utils/actor'

/**
 * Sibling of [...path].get.ts that catches the empty-path request to
 * `/api/drupal-ce/`. Nitro's catch-all does not match zero-segment paths,
 * so without this Nitro falls through to the page router and the catch-all
 * `[...slug].vue` ends up calling `fetchPage('/api/drupal-ce/')`, which
 * causes infinite SSR recursion.
 */
export default defineEventHandler(async (event) => {
  const qs = new URLSearchParams(getQuery(event) as Record<string, string>).toString()
  const url = `${drupalBaseUrl()}/ce-api${qs ? '?' + qs : ''}`
  const auth = forwardedAuthHeaders(event)
  const res = await fetchUpstream(url, { headers: { Accept: 'application/json', ...auth } })
  relaySetCookie(event, res)
  if (!res.ok) throw await upstreamError(res, 'CE-API front page')
  return enrichCePage(await res.json() as CePage, auth, await bodyAllowedHtml())
})
