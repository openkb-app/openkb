import { Extension } from '@tiptap/core'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'

/**
 * Turns a node selection over a non-selectable node, such as text, into a caret.
 *
 * When a co-editor deletes the selected node, @tiptap/y-tiptap 3.0.9–3.2.0
 * (`createSafeNodeSelection`) selects whatever follows it, and the bubble menus
 * throw. Remove once https://github.com/yjs/y-prosemirror/issues/283 is fixed
 * in y-tiptap.
 */
export const NodeSelectionOverTextToCaret = Extension.create({
  name: 'nodeSelectionOverTextToCaret',

  /** Replaces a node selection over a non-selectable node with a caret at its start. */
  dispatchTransaction({ transaction: tr, next }) {
    const { selection } = tr
    if (selection instanceof NodeSelection && !NodeSelection.isSelectable(selection.node)) {
      tr.setSelection(TextSelection.near(selection.$from))
    }
    next(tr)
  },
})
