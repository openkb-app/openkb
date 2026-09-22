import { defineEventHandler, setResponseHeader } from 'h3'
import { authorizationServerMetadata } from '../../utils/oauth-metadata'

/**
 * RFC 8414 authorization-server metadata — step 3 of connect-by-URL.
 *
 * Served here because this app is the issuer a client discovered; the
 * endpoints it names live on Drupal (see server/utils/oauth-metadata.ts).
 */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'access-control-allow-origin', '*')
  return await authorizationServerMetadata(event)
})
