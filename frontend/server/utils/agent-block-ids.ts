import type { Node as PMNode } from '@tiptap/pm/model'
import type { JSONContent } from '@tiptap/core'
import { editorSchema } from './editor-schema'
import { blockIdOf, isIdBearing, mintBlockId, type IdSource } from '#shared/page-blocks'

/**
 * Block ids for an agent's body write — the server-side counterpart of the
 * editor's minter (app/editor/block-id-minter.ts).
 *
 * A browser peer mints a stable id for every top-level block its edit created.
 * An agent joins the same session but carries no ProseMirror view and therefore
 * no minter, so without this its new blocks would land id-less — unaddressable
 * by everything the block model keys on.
 *
 * The agent lane differs from the browser lane in what it can observe, not in
 * what it produces. The minter sees each transaction's changed ranges; an agent
 * hands over a whole body and the two documents are all there is to compare.
 * Both restrictions come out the same way — mint for the blocks this write
 * authored, leave the rest alone:
 *
 *   - a top-level id-bearing block identical to one the document already had,
 *     id included, is the same block, carried through unchanged: an id-less
 *     one stays id-less (a commit must not stamp ids into content the session
 *     never touched — see server/utils/commit-block-ids.ts), and a duplicated
 *     id a peer left stays for the commit to resolve: the copy is the peer's
 *     block, and only the peer's write may credit it;
 *   - anything else without a usable id gets one: an authored block keeps its
 *     id only where no carried block and no earlier authored block wears it.
 *
 * Who wrote the blocks it names is not this lane's business either: the agent
 * write API names them and Drupal's presave attributes and flags them.
 */

/** A document's direct children, or an empty list. */
function topLevel(doc: JSONContent): JSONContent[] {
  return doc.content ?? []
}

/**
 * A block's identity for the carried-through match: content and id, as the
 * schema spells them out — a freshly parsed tree and one read back out of the
 * document differ in which attributes they name.
 */
function blockKey(node: JSONContent): string {
  return JSON.stringify(editorSchema.nodeFromJSON(node).toJSON())
}

/**
 * Ids for the blocks an agent's body authored: every authored top-level
 * id-bearing block reaches the document with a unique id, while those carried
 * over unchanged from `before` stay exactly as they were.
 *
 * Pure — returns a new tree plus the minted ids.
 */
export function mintAuthoredIds(
  before: PMNode,
  after: JSONContent,
  source?: IdSource,
): { json: JSONContent, minted: string[] } {
  // Blocks the previous document carried, as a multiset: two identical blocks
  // consume two slots, so a write that adds a third mints for it.
  const available = new Map<string, number>()
  for (const node of topLevel(before.toJSON() as JSONContent)) {
    if (!isIdBearing(node)) continue
    const key = blockKey(node)
    available.set(key, (available.get(key) ?? 0) + 1)
  }

  const seen = new Set<string>()
  const minted: string[] = []
  const fresh = (): string => {
    let id = mintBlockId(source)
    while (seen.has(id)) id = mintBlockId(source)
    seen.add(id)
    minted.push(id)
    return id
  }

  // Carried blocks first, wherever they sit: their ids are taken before an
  // authored block can claim one, so an authored block sharing an id is the
  // one re-minted, in the agent's own write.
  const carried = topLevel(after).map((node) => {
    if (!isIdBearing(node)) return true
    const key = blockKey(node)
    const left = available.get(key) ?? 0
    if (left === 0) return false
    available.set(key, left - 1)
    const id = blockIdOf(node)
    if (id !== null) seen.add(id)
    return true
  })

  const content = topLevel(after).map((node, at) => {
    if (carried[at]) return node
    const id = blockIdOf(node)
    if (id !== null && !seen.has(id)) {
      seen.add(id)
      return node
    }
    return { ...node, attrs: { ...(node.attrs ?? {}), id: fresh() } }
  })

  return { json: { ...after, content }, minted }
}
