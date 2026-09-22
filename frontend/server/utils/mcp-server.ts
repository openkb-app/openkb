import type { H3Event } from 'h3'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { fetchFrontmatterSchema } from './drupal'
import { callDrupalTool, listDrupalTools } from './drupal-tools'
import { kbTools, runKbTool, KB_INSTRUCTIONS } from './mcp-tools'
import type { KbTool, ToolResult } from './mcp-tools/types'

/**
 * The MCP server exposed at `/api/mcp` (see server/api/mcp.ts).
 *
 * It is an adapter, not a place where behaviour lives: the tools it executes
 * are declared and implemented one per file under server/utils/mcp-tools/, in
 * terms that name no protocol, and this file maps that set onto MCP's
 * `tools/list` and `tools/call`.
 *
 * Read tools go over the same read paths the HTTP endpoints use, so an agent
 * sees exactly what those endpoints serve (server/utils/kb-read.ts,
 * server/utils/kb-search.ts). Write tools go through the session router
 * (server/utils/session-router.ts) in-process: they join the document's live
 * collaborative session and let the commit service persist, exactly as
 * `POST /api/agent/edit` and the `.md` PUT do. No local tool writes to Drupal
 * directly, and there is no path by which one could.
 *
 * The tools Drupal owns are relayed over its own MCP endpoint as this caller,
 * generically: no Drupal tool's name occurs here, so one added over there
 * needs no change. A local tool of the same name wins, which is the only
 * ordering question there is to settle.
 *
 * The server grants nothing: every tool call forwards the request's Bearer
 * token to Drupal, which enforces access as the token's owner (capped by the
 * token's scopes — `agent_read` to read, `agent_write` to write). The endpoint
 * has already refused anything but a valid agent token before this server
 * runs.
 *
 * The server is built fresh per request (stateless streamable-HTTP), which is
 * what lets the tool schemas embed the live `GET /openkb/schema` contract:
 * place or remove a field in the `frontmatter` form display and both what
 * `getPageForEditing` reports and what `updateFields` accepts follow, with no
 * field list in this codebase.
 */

const NAME = 'openkb'
const VERSION = '1.0.0'

/** A tool declaration as MCP lists it. */
function toMcpTool(tool: KbTool): Tool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as Tool['inputSchema'],
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema as Tool['outputSchema'] } : {}),
  }
}

/**
 * A tool answer as MCP returns it.
 *
 * A refusal stays a tool *result* — `isError` on the call, never a protocol
 * error — so one failed call cannot take the connection with it.
 */
function toCallToolResult(result: ToolResult): CallToolResult {
  return {
    content: [{ type: 'text', text: result.text }],
    ...(result.data ? { structuredContent: result.data } : {}),
    ...(result.failed ? { isError: true } : {}),
  }
}

/**
 * Builds the MCP server for one request. Fetches the frontmatter schema up
 * front (authed as the request actor) so `tools/list` reports the live
 * contract; a schema fetch failure degrades the schema-derived tools to an
 * untyped object rather than failing the whole listing.
 */
export async function createMcpServer(event: H3Event): Promise<Server> {
  let frontmatterSchema: Record<string, unknown> = { type: 'object' }
  try {
    frontmatterSchema = await fetchFrontmatterSchema(event) as Record<string, unknown>
  }
  catch {
    // Leave the permissive default — the tools still work; only their schemas
    // are less specific.
  }

  const localTools = kbTools(frontmatterSchema)
  const localToolNames = new Set(localTools.map(tool => tool.name))

  const server = new Server(
    { name: NAME, version: VERSION },
    { capabilities: { tools: {} }, instructions: KB_INSTRUCTIONS },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...localTools.map(toMcpTool),
      ...(await listDrupalTools(event)).filter(tool => !localToolNames.has(tool.name)),
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args = {} } = request.params
    try {
      // Anything not local is Drupal's to answer or to refuse — including a
      // name nobody serves. Keeping no list of the rest here is what keeps the
      // relay blind to tool names, and what keeps an editing call off Drupal's
      // MCP endpoint.
      if (!localToolNames.has(name)) return await callDrupalTool(event, name, args)
      return toCallToolResult(await runKbTool(localTools, name, args, { event }))
    }
    catch (err) {
      // Drupal denied the read (403), the page vanished, or the backend is
      // unavailable — surface it as a tool error, not a transport failure.
      const status = (err as { statusCode?: number }).statusCode
      return toCallToolResult({
        text: status
          ? `Upstream request failed (${status}).`
          : `Tool "${name}" failed: ${(err as Error).message}`,
        failed: true,
      })
    }
  })

  return server
}
