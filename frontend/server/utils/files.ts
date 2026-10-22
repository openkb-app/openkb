import { DrupalJsonApiParams } from 'drupal-jsonapi-params'
import { drupalFetchWithAuth, publicDrupalBaseUrl } from './drupal'
import type { ResolvedFile } from '#shared/utils/files'

/**
 * File UUIDs → what a page file embed renders with, under the caller's own
 * carrier: core answers only the files the reader may download (ADR 0020), so
 * an unknown or unreadable UUID is simply absent.
 *
 * One request per file: JSON:API limits a filtered file collection to public
 * files and the caller's own uploads, whatever core's file access says.
 */

interface JsonApiFile {
  id: string
  attributes?: {
    filename?: string
    filesize?: number
    filemime?: string
    created?: string
    uri?: { url?: string }
  }
}

interface JsonApiFileDoc {
  data?: JsonApiFile
  included?: Array<{ id: string, attributes?: { display_name?: string, name?: string } }>
}

async function resolveFile(auth: Record<string, string>, uuid: string): Promise<ResolvedFile | null> {
  const params = new DrupalJsonApiParams()
    .addInclude(['uid'])
    .addFields('file--file', ['filename', 'filesize', 'filemime', 'created', 'uri', 'uid'])
    .addFields('user--user', ['display_name'])
  let doc: JsonApiFileDoc
  try {
    doc = await drupalFetchWithAuth<JsonApiFileDoc>(auth, `/jsonapi/file/file/${uuid}?${params.getQueryString()}`)
  }
  catch (err) {
    const status = (err as { statusCode?: number })?.statusCode
    if (status === 403 || status === 404) return null
    throw err
  }
  const file = doc.data
  const url = file?.attributes?.uri?.url
  if (!file || typeof url !== 'string') return null
  const owner = doc.included?.[0]?.attributes
  return {
    // Root-relative to Drupal; the browser downloads from the Drupal vhost
    // with the shared session cookie.
    url: url.startsWith('/') ? `${publicDrupalBaseUrl()}${url}` : url,
    name: file.attributes?.filename ?? '',
    size: file.attributes?.filesize ?? 0,
    mime: file.attributes?.filemime ?? '',
    owner: owner?.display_name ?? owner?.name ?? null,
    created: file.attributes?.created ?? null,
  }
}

/** Requests to Drupal in flight at once, per call. */
const PARALLEL = 6

export async function resolveFileUuids(
  auth: Record<string, string>,
  uuids: string[],
): Promise<Record<string, ResolvedFile>> {
  const resolved: Array<readonly [string, ResolvedFile | null]> = []
  for (let start = 0; start < uuids.length; start += PARALLEL) {
    const batch = uuids.slice(start, start + PARALLEL)
    resolved.push(...await Promise.all(batch.map(async uuid => [uuid, await resolveFile(auth, uuid)] as const)))
  }
  return Object.fromEntries(resolved.filter((entry): entry is readonly [string, ResolvedFile] => entry[1] !== null))
}

/**
 * The CSP for our HTML pages: frames load only from the Drupal origin, where
 * page files live. Holds for every navigation of a frame, also one its own
 * document starts, so an HTML embed cannot leave the origin that sandboxes it.
 * `dev` adds `'self'` for the Nuxt DevTools frame.
 */
export function embedFrameSrcPolicy(dev = false): string {
  return `frame-src ${dev ? '\'self\' ' : ''}${new URL(publicDrupalBaseUrl()).origin}`
}
