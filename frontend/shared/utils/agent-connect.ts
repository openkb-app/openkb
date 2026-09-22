/**
 * What a person has to paste to connect an agent to this site.
 *
 * One endpoint serves every MCP client — `POST /api/mcp` on the frontend — and
 * the two one-liners below are the same URL in the two shapes clients ask for
 * it. Built from the origin the reader is already on, so a dev stack, a review
 * env and production each name themselves without configuration.
 *
 * @see docs/agent-access.md
 */

/** The MCP endpoint on the given origin. */
export function mcpEndpoint(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/api/mcp`
}

/** The Claude Code command that connects it — no `--header`, it logs in. */
export function claudeCodeConnectCommand(origin: string): string {
  return `claude mcp add --transport http openkb ${mcpEndpoint(origin)}`
}
