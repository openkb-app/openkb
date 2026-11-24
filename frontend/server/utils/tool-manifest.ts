import { defineCachedFunction } from 'nitropack/runtime'
import { drupalBaseUrl } from './drupal'
import { fetchUpstream } from './upstream'

/**
 * Which session tools the site offers: Drupal's tool manifest.
 *
 * Drupal enables each tool with an `mcp_tool_config` and lists the enabled
 * session tools at {@link MANIFEST_PATH}, shaped as MCP's `tools/list`. It is
 * site config, the same for every caller, so it is cached under one key.
 */

/** Where Drupal lists the enabled session tools. */
const MANIFEST_PATH = '/openkb/agent/tool-manifest'

/** Seconds an answer is reused before Drupal is asked again. */
const MANIFEST_MAX_AGE = 60

/** Every `/mcp` request waits on an expired entry — it may not hang. */
const MANIFEST_TIMEOUT_MS = 2_000

/** The last answer and its validators, for revalidating an expired entry. */
let lastAnswer: { etag: string, lastModified: string, names: string[] } | undefined

/**
 * Reads the manifest, conditionally when there is an answer to revalidate.
 *
 * Drupal's page cache answers 304 when both validators match. `swr` is off, so
 * an expired entry is re-read before it is used, and a failed read is an error.
 */
const cachedManifest = defineCachedFunction(
  async (): Promise<string[]> => {
    const res = await fetchUpstream(`${drupalBaseUrl()}${MANIFEST_PATH}`, {
      headers: lastAnswer
        ? { 'If-None-Match': lastAnswer.etag, 'If-Modified-Since': lastAnswer.lastModified }
        : {},
      signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
    })
    if (res.status === 304 && lastAnswer) return lastAnswer.names
    if (!res.ok) throw new Error(`Drupal answered the tool manifest with ${res.status}`)

    const body = await res.json() as { tools?: { name?: unknown }[] }
    if (!Array.isArray(body.tools)) throw new Error('Drupal\'s tool manifest lists no tools')
    const names = body.tools.map(tool => tool.name).filter((name): name is string => typeof name === 'string')

    const etag = res.headers.get('etag')
    const lastModified = res.headers.get('last-modified')
    lastAnswer = etag && lastModified ? { etag, lastModified, names } : undefined
    return names
  },
  {
    name: 'tool-manifest',
    maxAge: MANIFEST_MAX_AGE,
    swr: false,
    getKey: () => 'site',
  },
)

/**
 * The `mcp_tool_config` ids of the session tools Drupal enables.
 *
 * Throws when Drupal cannot be read: which tools are offered is Drupal's to
 * say, and without Drupal none of them works anyway.
 */
export async function enabledSessionTools(): Promise<Set<string>> {
  return new Set(await cachedManifest())
}
