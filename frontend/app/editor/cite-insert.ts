import { Extension } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import type { EditorState } from '@tiptap/pm/state'
import { CITATION_TAG, citeKey, citeTarget, type CiteTarget } from '#shared/utils/citations'

export const caretMemoryKey = new PluginKey<number | null>('caretMemory')

/**
 * Keeps the caret a node selection replaced.
 *
 * The block menu selects the whole block as it opens, so by the time one of
 * its items runs, the position the author was typing at is gone from the
 * state. The memory moves with the document and is replaced by the next caret.
 */
export const CaretMemory = Extension.create({
  name: 'caretMemory',

  addProseMirrorPlugins() {
    return [
      new Plugin<number | null>({
        key: caretMemoryKey,
        state: {
          init: () => null,
          apply: (tr, value, _oldState, newState) =>
            newState.selection instanceof TextSelection
              ? newState.selection.head
              : (value === null ? null : tr.mapping.map(value)),
        },
      }),
    ]
  },
})

/** The remembered caret, when it lies inside the block at `pos`. */
export function caretInBlock(state: EditorState, pos: number): number | null {
  const held = caretMemoryKey.getState(state)
  const node = state.doc.nodeAt(pos)
  if (held == null || !node) return null
  return held > pos && held < pos + node.nodeSize ? held : null
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
