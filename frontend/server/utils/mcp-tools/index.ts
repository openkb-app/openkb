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
 * Tool API plugins (`openkb_tools`) and offers them from neither of its
 * consumers, since it cannot execute them.
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

/** How a client should approach the knowledge base. */
export const KB_INSTRUCTIONS
  = 'Access to OpenKnowledgebase. Content lives in spaces, and a space '
    + 'is an access boundary: call tool_api__list_spaces to see which ones you '
    + 'may work in and what you may do in each — the first segment of a page '
    + 'path is its space slug. To create a page, call tool_api__create_page '
    + 'with a title and the slug of a space tool_api__list_spaces reported as '
    + 'writable; it answers with the path it '
    + 'generated and the id of the one placeholder block the new page holds, '
    + 'which your first updateBlocks replaces. Use tool_api__search_pages to '
    + 'find pages. When you connect, call tool_api__list_assignments: it '
    + 'answers the comment threads people handed to you while you were away. '
    + 'There are two reads and they are not interchangeable: '
    + 'tool_api__get_page answers the page as it stands PUBLISHED — that is '
    + 'what to answer a question from and what to cite — while '
    + 'getPageForEditing answers the WORKING COPY, which is what an edit is '
    + 'based on. To change an existing page, use '
    + 'updateFields for frontmatter fields and updateBlocks for prose — naming '
    + 'the blocks you mean to change, by the `{#b-…}` ids getPageForEditing '
    + 'returns. Both edit inside the page\'s collaborative session, so a human editing '
    + 'the same page sees your changes as you make them. Writes go to the '
    + "page's draft, never straight to the published page, so an edit loop "
    + 'reads its own work back with getPageForEditing: getPageForEditing → '
    + 'updateBlocks → getPageForEditing. A block you change '
    + 'needs a human to sign it off before the page can be published — that '
    + "is an editor's decision, not yours. When you tell somebody where a "
    + "page stands, read it out of getPageForEditing's `status` "
    + '(`draft_exists`, `blocks_pending`, `can_publish`) rather than inferring '
    + 'it from these instructions.\n\n'
    + 'Always send `expect` on every updateBlocks op — the block version '
    + "getPageForEditing's `versions` map reported. Somebody may be editing "
    + 'the same page right now, and `expect` is what keeps you from silently '
    + 'overwriting them. A refused call answers `conflicts`, naming which '
    + 'blocks moved and what they hold now: re-apply your edit to that '
    + 'markdown and call again with the version it reported. A refusal costs '
    + 'one call and needs no read, so write on the version you have rather '
    + 'than re-reading to be sure. A call that succeeds reports the same thing '
    + 'for what it wrote — `applied.blocks` maps every block it touched to '
    + 'the version it holds now, a block you inserted under the id minted for '
    + 'it. That is the `expect` your next edit to that block sends. Chain '
    + 'edits on it; only read the page again when you need content you do not '
    + 'already have.\n\n'
    + 'Your first write puts you in the page as a peer and you stay there while '
    + 'you keep working, so the blocks your last write touched are marked as '
    + 'yours for whoever has the page open — you do not announce that '
    + 'separately, and it reserves nothing. `observers` counts the humans '
    + 'connected in browsers, never you: above zero means somebody is in the '
    + 'page with you, so keep edits small and expect them to move under you. '
    + '`entry` says whether your session found the page already open '
    + '("joined") or opened it ("started").\n\n'
    + 'To work on a page WHILE somebody edits it, loop on waitForChanges: it '
    + 'answers the moment the session moves and hands you a cursor to resume '
    + 'from, so you react to what a person does rather than re-reading the '
    + 'page. Act on `comments` addressed to you — read the thread, make the '
    + 'change, then answer it with commentOnBlock; act on `blocks` only where '
    + 'your instructions say to; and never write into a block `presence` says '
    + 'somebody is in. You cannot resolve a thread and nothing here can: the '
    + 'editor who raised the point is the one who closes it. A `session` event '
    + 'ends the loop.'
