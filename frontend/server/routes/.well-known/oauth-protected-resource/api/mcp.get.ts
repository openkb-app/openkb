import { defineEventHandler, setResponseHeader } from 'h3'
import { protectedResourceMetadata } from '../../../../utils/oauth-metadata'

/**
 * RFC 9728 protected-resource metadata for `/api/mcp` — step 2 of connect-by-
 * URL, the document the 401's `WWW-Authenticate` header points a client at.
 *
 * Public and unauthenticated by protocol: its whole job is to tell a client
 * that has no credentials yet where to go and get some.
 */
export default defineEventHandler(async (event) => {
  // Any MCP client may be browser-based, and discovery precedes any credential.
  setResponseHeader(event, 'access-control-allow-origin', '*')
  return await protectedResourceMetadata(event)
})
