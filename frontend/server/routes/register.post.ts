import { defineEventHandler, setResponseHeader, setResponseStatus } from 'h3'
import { drupalBaseUrl } from '../utils/drupal'
import { fetchUpstream } from '../utils/upstream'
import { readCappedBody } from '../utils/capped-body'
import { forwardedFor } from '../utils/forwarded-for'
import { collabAuthHeaders, collabIdentityConfigured, forgetCollabToken } from '../utils/collab-identity'

/**
 * RFC 7591 dynamic client registration — step 4 of connect-by-URL.
 *
 * A pass-through, and deliberately nothing more: the body is relayed to Drupal
 * byte for byte and the answer comes back unchanged, refusals included. Every
 * decision — the scopes a registration may ask for, the redirect-URI rules,
 * whether registration is open at all — is Drupal's, in
 * `openkb_agent_registration.settings`, because what a pasted URL may turn into
 * is a property of the site rather than of the server that relayed the request.
 *
 * One thing is added on the way through: this server's own Bearer token (ADR
 * 0001). Registration is anonymous by protocol, so the bridge cannot
 * authenticate the registrant and authenticates the relay instead. The
 * client's address goes along as X-Forwarded-For, so Drupal limits
 * registrations per client.
 */
const BRIDGE_PATH = '/openkb/agent/register'

/** Five redirect URIs at the consumer `redirect` field's max_length fit with room to spare. */
export const MAX_BODY_BYTES = 64 * 1024

export default defineEventHandler(async (event) => {
  if (!collabIdentityConfigured()) {
    setResponseStatus(event, 503)
    return {
      error: 'temporarily_unavailable',
      error_description: 'Client registration is not configured on this server.',
    }
  }

  const body = (await readCappedBody(event, MAX_BODY_BYTES)).toString('utf8')
  const relay = async (): Promise<Response> => fetchUpstream(`${drupalBaseUrl()}${BRIDGE_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...forwardedFor(event),
      ...(await collabAuthHeaders()),
    },
    body,
  })

  // A token Drupal no longer honours — the consumer re-provisioned, the keys
  // rotated — reads as a 401 here, which one freshly issued token answers.
  let res = await relay()
  if (res.status === 401) {
    forgetCollabToken()
    res = await relay()
  }

  setResponseStatus(event, res.status)
  setResponseHeader(event, 'access-control-allow-origin', '*')
  const retryAfter = res.headers.get('retry-after')
  if (retryAfter) {
    setResponseHeader(event, 'retry-after', retryAfter)
    // Not CORS-safelisted: browser MCP clients read it only when exposed.
    setResponseHeader(event, 'access-control-expose-headers', 'Retry-After')
  }
  try {
    return await res.json()
  }
  catch {
    // Drupal answered with something other than JSON — its 404 page when the
    // registration module is not installed, or an error page. A client
    // reading this expects OAuth's error shape, so say it in that shape and
    // keep the status the site gave.
    return {
      error: 'invalid_request',
      error_description: 'Client registration is not available on this site.',
    }
  }
})
