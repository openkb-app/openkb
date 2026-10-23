import { Plugin, Selection, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { fenceFor } from '#shared/utils/fences'

/**
 * ArrowUp/ArrowDown into a fence component's hidden source. The browser's
 * caret motion skips a `display: none` element; the node view opens the
 * source once the caret is inside.
 */
export function fenceCaretPlugin(codeBlock: string): Plugin {
  return new Plugin({
    props: {
      handleKeyDown(view, event) {
        if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false
        const dir = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
        if (!dir) return false
        const { selection } = view.state
        const $head = selection.$head
        if (!(selection instanceof TextSelection) || !selection.empty || !onEdgeLine(view, $head.pos, dir > 0 ? $head.end() : $head.start())) return false
        const next = Selection.findFrom(view.state.doc.resolve(dir > 0 ? $head.after() : $head.before()), dir, true)
        if (!next || !hiddenFence(view, next, codeBlock)) return false
        view.dispatch(view.state.tr.setSelection(next).scrollIntoView())
        return true
      },
    },
  })
}

/**
 * Whether the caret is on the textblock's first or last line.
 * `endOfTextblock` answers no beside the block's uneditable margin control.
 */
function onEdgeLine(view: EditorView, head: number, edge: number): boolean {
  return Math.abs(view.coordsAtPos(head).top - view.coordsAtPos(edge).top) < 2
}

function hiddenFence(view: EditorView, target: Selection, codeBlock: string): boolean {
  const block = target.$head.parent
  if (block.type.name !== codeBlock || !fenceFor(block.attrs.language)) return false
  const dom = view.nodeDOM(target.$head.before())
  const code = dom instanceof HTMLElement ? dom.querySelector('code') : null
  return code !== null && code.getClientRects().length === 0
}
