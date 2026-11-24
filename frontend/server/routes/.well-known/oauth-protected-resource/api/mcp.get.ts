import { defineEventHandler, setResponseHeader } from 'h3'
import { DEPRECATED_MCP_PATH, protectedResourceMetadata } from '../../../../utils/oauth-metadata'

/**
 * RFC 9728 protected-resource metadata for the endpoint's alias path.
 *
 * @deprecated Removed with `/api/mcp` after 1.0.
 */
export default defineEventHandler(async (event) => {
  // Any MCP client may be browser-based, and discovery precedes any credential.
  setResponseHeader(event, 'access-control-allow-origin', '*')
  return await protectedResourceMetadata(event, DEPRECATED_MCP_PATH)
})
