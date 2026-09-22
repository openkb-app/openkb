import type { H3Event } from 'h3'
import { defineEventHandler, getHeader, setResponseHeader, setResponseStatus } from 'h3'
import { MCP_RESOURCE_PATH, resourceOrigin } from '../utils/oauth-metadata'

/**
 * What a client pointed at the wrong path gets back — anything but HTML.
 *
 * `claude mcp add <url>` invites pasting the site *origin*, and one segment
 * off is the other common miss. The page catch-all answers an unauthenticated
 * caller with a redirect into the HTML gate, which an MCP client parses as
 * JSON-RPC and reports only as `CLIENT_HTTP_UNEXPECTED_CONTENT`.
 *
 * Middleware rather than routes, because both paths serve pages and so both
 * answers have to be able to *decline* — a browser asking for either lands on
 * the page it asked for, and a route handler has no clean way to step aside.
 */

/** A caller that takes HTML is served the page, whatever else it accepts. */
function acceptsHtml(event: H3Event): boolean {
  return /\btext\/html\b/i.test(getHeader(event, 'accept') ?? '')
}

/**
 * Whether this caller is speaking the MCP streamable-HTTP wire.
 *
 * That wire sends `application/json` and `text/event-stream` **together** on
 * every call. Either alone is an ordinary API caller, which the site root is
 * not this middleware's to answer for.
 */
function acceptsMcpWire(event: H3Event): boolean {
  const accept = getHeader(event, 'accept') ?? ''
  return /\bapplication\/json\b/i.test(accept) && /\btext\/event-stream\b/i.test(accept)
}

export default defineEventHandler((event) => {
  // A pasted URL is what this serves, so it is matched the way one is typed:
  // a trailing slash and any casing are the same miss.
  const path = (event.path.split('?')[0] ?? '').toLowerCase().replace(/\/$/, '')
  const atRoot = path === ''
  if ((!atRoot && path !== '/mcp') || acceptsHtml(event)) {
    return
  }
  if (atRoot && !acceptsMcpWire(event)) {
    return
  }

  // Both answers are chosen on `Accept`, so a cache may not serve one for the
  // other.
  setResponseHeader(event, 'vary', 'accept')

  // One segment off: send the client where it meant to go, method intact, so
  // the 401 + `WWW-Authenticate` discovery chain engages at the target.
  if (!atRoot) {
    setResponseHeader(event, 'location', MCP_RESOURCE_PATH)
    setResponseStatus(event, 308)
    return null
  }

  // No redirect at the site root — it is a page for humans. The answer offers
  // the endpoint rather than asserting what the caller came for.
  setResponseStatus(event, 404)
  return {
    error: 'not_found',
    error_description: `Nothing answers here. If you are looking for the MCP endpoint, it is at ${MCP_RESOURCE_PATH}.`,
    mcp_endpoint: `${resourceOrigin(event)}${MCP_RESOURCE_PATH}`,
  }
})
