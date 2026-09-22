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
 *   - a top-level id-bearing block that is byte-identical to an id-less block
 *     the document already had is the same block, carried through unchanged,
 *     and keeps its id-less state (a commit must not stamp ids into content
 *     the session never touched — see server/utils/commit-block-ids.ts);
 *   - anything else without a usable id gets one, duplicates included, first
 *     occurrence in document order keeping the id.
 *
 * Who wrote the blocks it names is not this lane's business either: the agent
 * write API names them and Drupal's presave attributes and flags them.
 */

/** A document's direct children, or an empty list. */
function topLevel(doc: JSONContent): JSONContent[] {
  return doc.content ?? []
}

/**
 * Content identity of a top-level block, for the carried-through match. The
 * id is excluded — that is the thing being decided.
 *
 * Takes a block as the schema spells it out: a freshly parsed tree and one
 * read back out of the document differ in which attributes they name, and the
 * match has to be on content, not on that.
 */
function blockKey(json: JSONContent): string {
  const attrs = { ...(json.attrs ?? {}) }
  delete attrs.id
  return JSON.stringify({ ...json, attrs })
}

/** A parsed block through the schema, so it keys against a document's own. */
function canonical(node: JSONContent): JSONContent {
  return editorSchema.nodeFromJSON(node).toJSON() as JSONContent
}

/**
 * Ids for the blocks an agent's body authored: every top-level id-bearing
 * block reaches the document with a unique id, except those carried over
 * unchanged from `before`, which stay exactly as they were.
 *
 * Pure — returns a new tree plus the minted ids.
 */
export function mintAuthoredIds(
  before: PMNode,
  after: JSONContent,
  source?: IdSource,
): { json: JSONContent, minted: string[] } {
  // Blocks the previous document carried without an id, as a multiset: two
  // identical id-less paragraphs consume two slots, so a write that adds a
  // third mints for one of them.
  const carried = new Map<string, number>()
  for (const node of topLevel(before.toJSON() as JSONContent)) {
    if (!isIdBearing(node) || blockIdOf(node) !== null) continue
    const key = blockKey(node)
    carried.set(key, (carried.get(key) ?? 0) + 1)
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

  const content = topLevel(after).map((node) => {
    if (!isIdBearing(node)) return node
    const id = blockIdOf(node)
    if (id !== null && !seen.has(id)) {
      seen.add(id)
      return node
    }
    if (id === null) {
      const key = blockKey(canonical(node))
      const available = carried.get(key) ?? 0
      if (available > 0) {
        carried.set(key, available - 1)
        return node
      }
    }
    return { ...node, attrs: { ...(node.attrs ?? {}), id: fresh() } }
  })

  return { json: { ...after, content }, minted }
}
