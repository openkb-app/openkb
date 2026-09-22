import type { H3Event } from 'h3'

/**
 * What a knowledge-base tool is, independent of who calls it.
 *
 * No MCP type appears here, and none may: `server/utils/mcp-server.ts` adapts
 * these onto the protocol, and a second runtime is meant to consume the same
 * set. A tool file states what it takes, what it answers and what it does —
 * never how a protocol frames that.
 *
 * The same four tools are declared in Drupal as Tool API plugins
 * (`openkb_tools`, ADR 0009), which is the one registry of the whole surface;
 * these are the executable halves Drupal cannot run.
 */
export interface KbTool {
  name: string
  description: string
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  run: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>
}

/**
 * A tool as declared for one request: two tools embed the live frontmatter
 * exposure contract (`GET /openkb/schema`) in their schemas, so the
 * declaration is built per request rather than held as a constant.
 */
export type KbToolFactory = (frontmatterSchema: JsonSchema) => KbTool

/** JSON Schema, as far as a tool declaration cares. */
export type JsonSchema = Record<string, unknown>

/** What a tool call runs against. */
export interface ToolContext {
  event: H3Event
}

/**
 * What a tool answers: prose for the model, the same thing structured for the
 * caller. `failed` marks a refusal — a result the caller must act on, never a
 * transport failure, so one bad call cannot take the connection with it.
 */
export interface ToolResult {
  text: string
  data?: Record<string, unknown>
  failed?: boolean
}

/** An answered call. */
export function answered(text: string, data?: Record<string, unknown>): ToolResult {
  return { text, ...(data ? { data } : {}) }
}

/** A refused call. */
export function refused(text: string, data?: Record<string, unknown>): ToolResult {
  return { text, ...(data ? { data } : {}), failed: true }
}
