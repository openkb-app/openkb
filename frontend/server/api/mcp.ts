import { createError, defineEventHandler, getHeader, readBody, setResponseHeader } from 'h3'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { resolveActor } from '../utils/actor'
import { createMcpServer } from '../utils/mcp-server'
import { wwwAuthenticate } from '../utils/oauth-metadata'

/**
 * MCP server endpoint (streamable-HTTP), the Nitro-native counterpart to the
 * chat proxy. The tool surface it serves is
 * server/utils/mcp-tools/, adapted onto the protocol by
 * server/utils/mcp-server.ts.
 *
 * Bearer-only: agents act as their owner, whether the credential is a personal
 * consumer or a client the user connected by pasting this URL. A request
 * without an `Authorization: Bearer` token is not an MCP client and gets 401;
 * a token Drupal rejects surfaces as 401 (resolveActor passes the simple_oauth
 * rejection through); a carrier that resolves to a human/anonymous actor gets
 * 403. Past that guard, every tool call forwards the token to Drupal, which
 * enforces access as the owner — the frontend grants nothing.
 *
 * Every unauthorized answer carries `WWW-Authenticate` naming this resource's
 * metadata document (RFC 9728 §5.1). That header is the entire entry point to
 * connect-by-URL: it is how a client that was handed nothing but this URL
 * finds out where to log its user in. Set before the guards, so a rejected
 * token discovers auth the same way a missing one does.
 *
 * Stateless transport (`sessionIdGenerator: undefined`): a fresh server +
 * transport per request, torn down on response close. JSON responses
 * (`enableJsonResponse`) keep the wire simple for scripted clients; the SDK
 * client handles them transparently.
 */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'www-authenticate', wwwAuthenticate(event))

  const authorization = getHeader(event, 'authorization')
  if (!authorization || !/^Bearer /i.test(authorization)) {
    throw createError({ statusCode: 401, statusMessage: 'Bearer token required' })
  }

  const actor = await resolveActor(event)
  if (actor.type !== 'agent') {
    throw createError({ statusCode: 403, statusMessage: 'Agent token required' })
  }

  const body = event.method === 'POST' ? await readBody(event) : undefined

  const server = await createMcpServer(event)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })

  event.node.res.on('close', () => {
    void transport.close()
    void server.close()
  })

  await server.connect(transport)
  await transport.handleRequest(event.node.req, event.node.res, body)
})
