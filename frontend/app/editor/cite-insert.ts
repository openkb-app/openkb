import type { Editor } from '@tiptap/core'
import { CITATION_TAG, citeKey, citeTarget, type CiteTarget } from '#shared/utils/citations'

/**
 * What the `[[` picker inserts when it was opened to cite rather than to link.
 *
 * Both are the same picker (editor/components/DocLinkMenu.vue) and the same
 * `[[` in the text; only the node a pick becomes differs. The block menu's
 * Cite item records its intent against the position its `[[` lands at, and the
 * picker reads it back when a target is chosen.
 *
 * The key is what keeps an abandoned `[[` out of a later pick: a record whose
 * position no longer matches is dropped and the pick is an ordinary link.
 */

let intended: number | null = null

/** Records that the `[[` at `at` is being opened to cite. */
export function recordCiteInsert(at: number): void {
  intended = at
}

/** Whether the `[[` at `at` was opened to cite. Reads once. */
export function takeCiteInsert(at: number): boolean {
  const held = intended
  intended = null
  return held === at
}

/**
 * Advances a citation the block already carries to the version just picked.
 *
 * Re-citing is an ordinary body edit: the node's version becomes the one the
 * author has just read, which is what clears a stale or dangling mark. A block
 * never carries the same source twice, so a pick naming one it already cites
 * moves that node instead of adding another.
 *
 * Returns false where the block cites this source for the first time; the
 * caller then inserts.
 */
export function reciteInBlock(editor: Editor, target: CiteTarget, v: string | null): boolean {
  const { $from } = editor.state.selection
  if ($from.depth < 1) return false
  const key = citeKey(target)
  let at = -1
  editor.state.doc.nodesBetween($from.before(1), $from.after(1), (node, pos) => {
    if (at >= 0 || node.type.name !== CITATION_TAG) return
    const carried = citeTarget(node.attrs as Record<string, unknown>)
    if (carried && citeKey(carried) === key) at = pos
  })
  if (at < 0) return false
  editor.chain().focus().command(({ tr }) => {
    tr.setNodeAttribute(at, 'v', v)
    return true
  }).run()
  return true
}
