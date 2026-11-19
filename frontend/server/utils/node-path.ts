import type { H3Event } from 'h3'
import { forwardedAuthHeaders } from './actor'
import { fetchCeNode } from './drupal'

/**
 * The path of a page, read under the visitor's own session.
 *
 * It is the page's live-revision read, so Drupal's refusal is the answer: 403
 * where the visitor may not read the page, 404 where it is absent or its space
 * hides it. A page without an alias answers `/node/<nid>`.
 */
export async function resolveNodePath(event: H3Event, nid: number): Promise<string> {
  const read = await fetchCeNode(forwardedAuthHeaders(event), nid)
  return read.page.path
}
