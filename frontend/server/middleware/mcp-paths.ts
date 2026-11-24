import type { H3Event } from 'h3'
import { defineEventHandler, getHeader, setResponseHeader, setResponseStatus } from 'h3'
import { serveMcp } from '../utils/mcp-endpoint'
import { MCP_PATH, resourceOrigin } from '../utils/oauth-metadata'

/**
 * Serves the MCP endpoint at `/mcp`, and answers an MCP client pointed at the
 * site origin in JSON rather than with the HTML gate.
 *
 * `/mcp` is the conventional path, served in place because clients do not
 * reliably follow a redirect on POST. The origin is what `claude mcp add <url>`
 * invites pasting; the gate there is reported only as
 * `CLIENT_HTTP_UNEXPECTED_CONTENT`.
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
  const path = (event.path.split('?')[0] ?? '').replace(/\/$/, '')
  const atRoot = path === ''
  if ((!atRoot && path !== MCP_PATH) || acceptsHtml(event)) {
    return
  }
  if (atRoot && !acceptsMcpWire(event)) {
    return
  }

  // Both answers are chosen on `Accept`, so a cache may not serve one for the
  // other.
  setResponseHeader(event, 'vary', 'accept')

  if (!atRoot) {
    return serveMcp(event)
  }

  // No redirect at the site root — it is a page for humans. The answer offers
  // the endpoint rather than asserting what the caller came for.
  setResponseStatus(event, 404)
  return {
    error: 'not_found',
    error_description: `Nothing answers here. If you are looking for the MCP endpoint, it is at ${MCP_PATH}.`,
    mcp_endpoint: `${resourceOrigin(event)}${MCP_PATH}`,
  }
})
