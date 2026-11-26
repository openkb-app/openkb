import { createError } from 'h3'
import { defineCachedFunction } from 'nitropack/runtime'
import { asCollabServer } from './collab-identity'
import { drupalBaseUrl } from './drupal'
import { asSchema } from './mcp-tools/schemas'
import type { JsonSchema } from './mcp-tools/types'
import { fetchUpstream } from './upstream'

/**
 * Which session tools the site offers, and every text agents read about them:
 * Drupal's tool manifest.
 *
 * Drupal enables each tool with an `mcp_tool_config` and lists the enabled
 * session tools at {@link MANIFEST_PATH}, shaped as MCP's `initialize` and
 * `tools/list`: the server instructions, and per tool its description and the
 * descriptions of its inputs. It is site config, the same for every caller, so
 * it is cached under one key.
 */

/** One enabled session tool, as Drupal describes it. */
export interface ManifestTool {
  description: string
  /** Descriptions only, nested as the tool's input schema nests them. */
  inputSchema: JsonSchema
}

/** What the manifest says. */
export interface ToolManifest {
  instructions: string
  /** Keyed by `mcp_tool_config` id. */
  tools: Map<string, ManifestTool>
}

/** The manifest as it travels, and as it is cached. */
interface ManifestBody {
  instructions: string
  tools: ({ name: string } & ManifestTool)[]
}

/** Where Drupal lists the enabled session tools. */
const MANIFEST_PATH = '/openkb/agent/tool-manifest'

/** Seconds an answer is reused before Drupal is asked again. */
const MANIFEST_MAX_AGE = 60

/** Bounds the first read and each background refresh. */
const MANIFEST_TIMEOUT_MS = 2_000

/**
 * Reads the manifest as the frontend's server identity (`collab-identity.ts`).
 *
 * - The route answers only that identity: the texts are not public.
 * - Stale-while-revalidate: an expired entry is served at once while Drupal is
 *   read in the background; a failed refresh keeps the entry.
 */
const cachedManifest = defineCachedFunction(
  (): Promise<ManifestBody> => asCollabServer(readFromDrupal),
  {
    name: 'tool-manifest',
    maxAge: MANIFEST_MAX_AGE,
    swr: true,
    getKey: () => 'site',
  },
)

/** Reads the manifest from Drupal, or throws. */
async function readFromDrupal(auth: Record<string, string>): Promise<ManifestBody> {
  const res = await fetchUpstream(`${drupalBaseUrl()}${MANIFEST_PATH}`, {
    headers: auth,
    signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw createError({ statusCode: res.status, statusMessage: `Drupal answered the tool manifest with ${res.status}` })
  }
  return readManifest(await res.json())
}

/** The manifest's JSON, or a throw when it is not shaped as one. */
function readManifest(json: unknown): ManifestBody {
  const body = json as { instructions?: unknown, tools?: unknown }
  if (!Array.isArray(body?.tools)) throw new Error('Drupal\'s tool manifest lists no tools')
  if (typeof body.instructions !== 'string') throw new Error('Drupal\'s tool manifest has no instructions text')
  const tools = (body.tools as Record<string, unknown>[])
    .filter(tool => typeof tool?.name === 'string')
    .map(tool => ({
      name: tool.name as string,
      description: typeof tool.description === 'string' ? tool.description : '',
      inputSchema: asSchema(tool.inputSchema) ?? {},
    }))
  return { instructions: body.instructions, tools }
}

/**
 * The session tools Drupal enables, and the texts to serve with them.
 *
 * Throws when Drupal was never read: which tools are offered is Drupal's to
 * say.
 */
export async function toolManifest(): Promise<ToolManifest> {
  const { instructions, tools } = await cachedManifest()
  return {
    instructions,
    tools: new Map(tools.map(({ name, ...tool }) => [name, tool])),
  }
}
