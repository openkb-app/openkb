import { getPageForEditingTool } from './get-page-for-editing'
import { updateFieldsTool } from './update-fields'
import { updateBlocksTool } from './update-blocks'
import { commentOnBlockTool } from './comment-on-block'
import { waitForChangesTool } from './wait-for-changes'
import { withoutWidgetHints } from './schemas'
import { refused, type JsonSchema, type KbTool, type ToolContext, type ToolResult } from './types'

/**
 * The knowledge-base tool set, and the only place it is enumerated.
 *
 * One file per tool holds that tool's declaration and its handler; nothing
 * here knows about MCP. `server/utils/mcp-server.ts` adapts this set onto the
 * MCP protocol, and a second runtime can adapt the same set onto its own — a
 * tool added here reaches both without being described twice.
 *
 * These are the tools ADR 0009 puts in the frontend server, because they
 * interact with the live editing session. Drupal declares the same set as
 * Tool API plugins (`openkb_tools`), enables each with an `mcp_tool_config`
 * and describes it; the MCP server offers only the enabled ones.
 *
 * The frontmatter exposure contract arrives raw and is stripped of its
 * form-rendering hints here: what the tool surface exposes is the tools'
 * decision, not the protocol's.
 */
export function kbTools(frontmatterSchema: JsonSchema): KbTool[] {
  const exposed = withoutWidgetHints(frontmatterSchema)
  return [
    getPageForEditingTool(exposed),
    updateFieldsTool(exposed),
    updateBlocksTool(),
    commentOnBlockTool(),
    waitForChangesTool(),
  ]
}

/** Runs one tool by name. An unknown name is a refusal, not a throw. */
export async function runKbTool(
  tools: KbTool[],
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const tool = tools.find(candidate => candidate.name === name)
  if (!tool) return refused(`Unknown tool: ${name}`)
  const undeclared = undeclaredArguments(tool.inputSchema, args)
  if (undeclared.length > 0) {
    return refused(
      `${name} takes no ${undeclared.map(entry => entry.at).join(', ')}. `
      + `What may sit there: ${undeclared[0]!.declared.join(', ')}.`,
    )
  }
  return tool.run(args, context)
}

/** The arguments one schema declares. */
function declaredProperties(schema: JsonSchema): Record<string, JsonSchema> {
  const properties = schema.properties
  return typeof properties === 'object' && properties !== null
    ? properties as Record<string, JsonSchema>
    : {}
}

/** An argument no schema on its path declares, and what may sit there instead. */
interface Undeclared {
  /** Where it sat — `blocks[0].expects` inside a list of ops. */
  at: string
  declared: string[]
}

/**
 * Every argument a tool closed to extras does not declare, down through nested
 * objects and list items. A typo — or a field the tool deliberately has no say
 * over, like a thread's `resolved` — is refused rather than silently ignored.
 */
function undeclaredArguments(schema: JsonSchema, value: unknown, at = ''): Undeclared[] {
  if (Array.isArray(value)) {
    const items = schema.items as JsonSchema | undefined
    return items
      ? value.flatMap((entry, index) => undeclaredArguments(items, entry, `${at}[${index}]`))
      : []
  }
  if (typeof value !== 'object' || value === null) return []
  const declared = declaredProperties(schema)
  return Object.entries(value).flatMap(([key, entry]) => {
    const where = at ? `${at}.${key}` : key
    if (key in declared) return undeclaredArguments(declared[key]!, entry, where)
    return schema.additionalProperties === false
      ? [{ at: where, declared: Object.keys(declared) }]
      : []
  })
}
