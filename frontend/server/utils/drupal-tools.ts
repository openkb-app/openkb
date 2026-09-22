import { createHash } from 'node:crypto'
import type { H3Event } from 'h3'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { defineCachedFunction } from 'nitropack/runtime'
import { forwardedAuthHeaders } from './actor'
import { drupalBaseUrl } from './drupal'

/**
 * Drupal's tools, reached over MCP.
 *
 * ADR 0009: the wire between the runtimes is the protocol itself. Drupal
 * serves its tools — spaces, and whatever joins them — at its own MCP
 * endpoint, and this file is an MCP client against it: `tools/list` is the
 * manifest, `tools/call` is the call. Nothing here knows what any tool does or
 * what any of them is called, so a tool added over there needs no change here.
 *
 * Every request carries the caller's own credential, so the listing is what
 * *this* caller may call and the call is authorized as them. The frontend
 * grants nothing, exactly as the session-bound tools next door do not.
 *
 * A session is opened only when there is something to say on it: a relayed
 * `tools/call`, or a listing the cache cannot answer. A request that only
 * touches the session-bound editing tools never reaches Drupal's MCP endpoint
 * at all.
 *
 * The listing is cached **per caller**. It is access-filtered, so one cache
 * key per credential is what keeps one caller's tools out of another's
 * manifest. `tools/call` is never cached — it is the side effect.
 */

/** Client identity in the upstream handshake. */
const CLIENT_INFO = { name: 'openkb-frontend', version: '1.0.0' }

/**
 * Ceiling for the handshake and the listing: a Drupal that hangs costs the
 * relayed tools, not the request being answered. A relayed `tools/call` keeps
 * the SDK's own ceiling — cutting a tool short would abandon its work.
 */
const HANDSHAKE_TIMEOUT_MS = 2_500

/** Seconds a caller's listing stays good. */
const LISTING_MAX_AGE = 30

/** An open MCP session against Drupal. */
interface Session {
  client: Client
  transport: StreamableHTTPClientTransport
}

/**
 * The cache key for a caller's listing: their credential, hashed.
 *
 * The raw carrier is a secret and cache keys are not — sha256 keeps callers
 * apart without the key being usable as one.
 */
function callerKey(event: H3Event): string {
  const auth = forwardedAuthHeaders(event)
  const carrier = auth.Authorization ?? auth.Cookie
  if (!carrier) return 'anonymous'
  return createHash('sha256').update(carrier).digest('hex')
}

/** Opens an MCP session against Drupal as the caller. */
async function connect(event: H3Event): Promise<Session> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${drupalBaseUrl()}/mcp`),
    { requestInit: { headers: forwardedAuthHeaders(event) } },
  )
  const client = new Client(CLIENT_INFO)
  await client.connect(transport, { timeout: HANDSHAKE_TIMEOUT_MS })
  return { client, transport }
}

/**
 * Ends the upstream session — DELETE, then drop the transport.
 *
 * mcp_server holds sessions in a SharedTempStore that core's expirable
 * key-value cron collects, so an orphan does expire — after a week. The DELETE
 * costs one request and keeps the store to the sessions in use.
 */
async function disconnect(session: Session): Promise<void> {
  try {
    await session.transport.terminateSession()
  }
  catch (err) {
    console.warn('[mcp] upstream session not terminated', err)
  }
  await session.client.close()
}

/**
 * Lists the tools this caller may call, over one short-lived session.
 *
 * Cached under {@link callerKey}: a shared key would hand one caller the tools
 * another may call, and the listing is access-filtered precisely so it does
 * not. `swr` is off — an expired entry is re-read rather than served stale,
 * because what it holds is an access answer.
 */
const cachedListing = defineCachedFunction(
  async (event: H3Event, _key: string): Promise<Tool[]> => {
    const session = await connect(event)
    try {
      const { tools } = await session.client.listTools(undefined, { timeout: HANDSHAKE_TIMEOUT_MS })
      return tools
    }
    finally {
      await disconnect(session)
    }
  },
  {
    name: 'drupal-tools',
    maxAge: LISTING_MAX_AGE,
    swr: false,
    getKey: (_event: H3Event, key: string) => key,
  },
)

/**
 * The Drupal tools this caller may call, or none.
 *
 * A Drupal that is unreachable, out of date or has the module switched off —
 * and a caller it refuses — all land here, and all cost that caller the Drupal
 * tools and nothing else. Logged with the cause: a tool that stops being
 * advertised is otherwise unobservable.
 */
export async function listDrupalTools(event: H3Event): Promise<Tool[]> {
  try {
    return await cachedListing(event, callerKey(event))
  }
  catch (err) {
    console.warn('[mcp] Drupal tools not listed — relaying none', err)
    return []
  }
}

/**
 * Calls one Drupal tool on a session opened for it.
 *
 * Refusals come back as tool results, not thrown errors, as the session-bound
 * tools do it: a mistyped argument is an ordinary mistake to correct. A name
 * Drupal does not serve is refused the same way, by Drupal — the relay keeps
 * no list of what exists.
 */
export async function callDrupalTool(
  event: H3Event,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  let session: Session | null = null
  try {
    session = await connect(event)
    return await session.client.callTool({ name, arguments: args }) as CallToolResult
  }
  catch (err) {
    console.warn(`[mcp] tool "${name}" not relayed`, err)
    return {
      content: [{ type: 'text', text: `Tool "${name}" failed: ${(err as Error).message}` }],
      isError: true,
    }
  }
  finally {
    if (session) await disconnect(session)
  }
}
