import { defineEventHandler, setResponseHeader } from 'h3'
import { protectedResourceMetadata } from '../../utils/oauth-metadata'

/**
 * The same RFC 9728 document as the path-suffixed route, at the root form.
 *
 * A client handed the site origin rather than `/api/mcp` derives this URL, and
 * without it the request falls through to the page catch-all and comes back as
 * HTML. Serving it here answers that client with the document it was looking
 * for — which names `/api/mcp` as the resource, so it can carry on.
 */
export default defineEventHandler(async (event) => {
  // Any MCP client may be browser-based, and discovery precedes any credential.
  setResponseHeader(event, 'access-control-allow-origin', '*')
  return await protectedResourceMetadata(event)
})
