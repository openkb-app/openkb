import { defineEventHandler } from 'h3'
import { drupalBaseUrl } from '../../utils/drupal'
import { fetchUpstream, upstreamError } from '../../utils/upstream'
import { forwardedAuthHeaders } from '../../utils/actor'

/**
 * Proxies the derived frontmatter JSON Schema (`GET /openkb/schema`, the
 * openkb_schema module) to the browser, so the FrontmatterForm can render one
 * input per placed field without a hardcoded field list.
 *
 * The request's auth carrier (session cookie or agent Bearer token) is
 * forwarded so Drupal applies the same access as it does for the field
 * values. Failure follows the shared taxonomy: a 5xx / transport
 * error collapses to 503, an upstream 4xx passes its class through, and the
 * upstream body never reaches the client — the form shows the branded
 * ErrorState off the status alone.
 */
export default defineEventHandler(async (event) => {
  const res = await fetchUpstream(`${drupalBaseUrl()}/openkb/schema`, {
    headers: { Accept: 'application/json', ...forwardedAuthHeaders(event) },
  })
  if (!res.ok) throw await upstreamError(res, 'openkb schema')
  return await res.json()
})
