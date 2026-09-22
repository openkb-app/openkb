import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { isChangeOrigin } from '@tiptap/extension-collaboration'
import type { Node as PMNode } from '@tiptap/pm/model'
import { blockIdOf, ID_BEARING_TYPES, mintBlockId } from '#shared/page-blocks'

/**
 * Block ids, minted as the editor writes.
 *
 * Every top-level block the local user touches ends up on a unique stable id:
 * minted where it is missing, re-minted where a split left two blocks sharing
 * one. The id is content — it round-trips through the markdown as `{#id}` — and
 * everything else about a block is keyed on it: who wrote it, what review it
 * owes, which comment hangs off it. Nested blocks (list items, table cells) are
 * never id-bearing; shared/page-blocks.ts says why the granularity stops at
 * the document's direct children.
 *
 * Minting is all this does. Who wrote what is not the editor's word to give:
 * the collab server witnesses the ops it applies and Drupal witnesses the
 * writes it stores, and a client-side record would be a third opinion nobody
 * could check.
 *
 * The doc-walking helpers stay free of Y.js and of the editor instance, so they
 * unit-test against a plain document built from the shared schema.
 */

// ---------------------------------------------------------------------------
// Pure document helpers
// ---------------------------------------------------------------------------

/** Whether a top-level node is a block in its own right. */
function isIdBearing(node: PMNode): boolean {
  return ID_BEARING_TYPES.has(node.type.name)
}

/**
 * Walks the document's direct children, handing each to `visit` along with its
 * document position. Top-level positions are the child offsets, because the
 * doc's content starts at position 0.
 */
function eachTopLevel(doc: PMNode, visit: (node: PMNode, pos: number) => void): void {
  doc.forEach((node, offset) => visit(node, offset))
}

/** A top-level block that must be given an id, and the id it must lose (if any). */
export interface IdAssignment {
  pos: number
  /** The duplicate id being replaced, or null when the block simply had none. */
  replaces: string | null
}

/**
 * Top-level blocks that need an id minted, as positions into `doc`.
 *
 * Two cases, both of which break the keying model if left alone:
 *
 *   - **Missing** — a block the editor created without an id (typing a fresh
 *     paragraph). Only blocks overlapping one of the given (new-doc) ranges
 *     qualify, so a small edit does not stamp an id onto every id-less block
 *     in the document at once.
 *   - **Duplicated** — splitting a block copies its attributes wholesale, so
 *     both halves come out carrying the same id. This is scanned over the
 *     WHOLE document, not just the changed ranges: a split shows up as one
 *     changed range but corrupts a key shared with a block that may sit
 *     outside it. The first occurrence in document order keeps the id.
 */
export function blocksNeedingIds(doc: PMNode, ranges: Array<[number, number]>): IdAssignment[] {
  const out: IdAssignment[] = []
  const seen = new Set<string>()

  const touched = (from: number, to: number) =>
    ranges.some(([lo, hi]) => from < hi && to > lo)

  eachTopLevel(doc, (node, pos) => {
    if (!isIdBearing(node)) return
    const id = blockIdOf(node)
    if (id === null) {
      if (touched(pos, pos + node.nodeSize)) out.push({ pos, replaces: null })
      return
    }
    if (seen.has(id)) out.push({ pos, replaces: id })
    else seen.add(id)
  })

  return out
}

/** Ids already in use at the top level — the collision set for fresh mints. */
export function usedBlockIds(doc: PMNode): Set<string> {
  const used = new Set<string>()
  eachTopLevel(doc, (node) => {
    const id = blockIdOf(node)
    if (id && isIdBearing(node)) used.add(id)
  })
  return used
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

export const blockIdMinterKey = new PluginKey('blockIdMinter')

/**
 * The ProseMirror plugin behind {@link BlockIdMinter}. Factored out so it can
 * be exercised with a plain EditorState — minting happens in
 * appendTransaction, which needs no editor view.
 */
export function createBlockIdPlugin(): Plugin {
  return new Plugin({
    key: blockIdMinterKey,

    // Mint ids for the top-level blocks this local edit left without a usable
    // key: the ones it created id-less (limited to the changed ranges, so a
    // small edit does not id the whole document at once) and the ones a split
    // left sharing an id with a sibling (scanned document-wide — a duplicate
    // is a broken key wherever the other half ended up).
    appendTransaction(transactions, _oldState, newState) {
      const local = transactions.filter(tr => tr.docChanged && !isChangeOrigin(tr))
      if (local.length === 0) return null
      const ranges: Array<[number, number]> = []
      for (const tr of local) {
        for (const map of tr.mapping.maps) {
          map.forEach((_os, _oe, ns, ne) => ranges.push([ns, ne]))
        }
      }
      const assignments = blocksNeedingIds(newState.doc, ranges)
      if (assignments.length === 0) return null
      const used = usedBlockIds(newState.doc)
      const tr = newState.tr
      for (const { pos } of assignments) {
        let id = mintBlockId()
        while (used.has(id)) id = mintBlockId()
        used.add(id)
        tr.setNodeAttribute(pos, 'id', id)
      }
      // Undoable, with the edit it is appended to. y-tiptap reads one
      // `addToHistory` off the last document change in a dispatch and applies
      // it to the whole Y update that dispatch writes, so excluding the mint
      // here would exclude the keystroke that asked for it.
      return tr
    },
  })
}

export const BlockIdMinter = Extension.create({
  name: 'blockIdMinter',

  addProseMirrorPlugins() {
    return [createBlockIdPlugin()]
  },
})
