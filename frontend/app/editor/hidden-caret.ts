import { Extension } from '@tiptap/core'
import { Plugin, Selection, TextSelection, type EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

/**
 * ArrowUp/ArrowDown from a textblock's edge line into hidden text the
 * browser's caret motion skips: a fence component's source or a closed
 * collapsible section's body (`display: none`). The node view opens once the
 * caret is inside. Shown text and atom blocks are left to the browser and
 * ProseMirror.
 */
export function hiddenCaretPlugin(): Plugin {
  return new Plugin({
    props: {
      /** Moves the caret into the hidden text, if the arrow key leads there. */
      handleKeyDown(view, event) {
        const dir = arrowDirection(event)
        if (!dir || isSuggestionMenuOpen(view.state)) {
          return false
        }
        const next = hiddenTextPastEdgeLine(view, dir)
        if (!next) {
          return false
        }
        view.dispatch(view.state.tr.setSelection(next).scrollIntoView())
        return true
      },
    },
  })
}

/** 1 for a plain ArrowDown, -1 for a plain ArrowUp, else 0. */
function arrowDirection(event: KeyboardEvent): number {
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
    return 0
  }
  if (event.key === 'ArrowDown') {
    return 1
  }
  if (event.key === 'ArrowUp') {
    return -1
  }
  return 0
}

/**
 * The caret in the hidden text right past the textblock's edge line in `dir`,
 * or null when the caret is not on that line, or the next stop is shown text
 * or an atom block.
 */
function hiddenTextPastEdgeLine(view: EditorView, dir: number): Selection | null {
  const { selection } = view.state
  if (!(selection instanceof TextSelection) || !selection.empty) {
    return null
  }
  if (!view.endOfTextblock(dir > 0 ? 'down' : 'up')) {
    return null
  }
  const $head = selection.$head
  const outside = view.state.doc.resolve(dir > 0 ? $head.after() : $head.before())
  const next = Selection.findFrom(outside, dir)
  if (!(next instanceof TextSelection) || !isPositionHidden(view, next.head)) {
    return null
  }
  return next
}

/**
 * The editor extension for `hiddenCaretPlugin()`: registered once for all
 * nodes, not per component.
 */
export const HiddenCaretKeys = Extension.create({
  name: 'hiddenCaretKeys',
  addProseMirrorPlugins() {
    return [hiddenCaretPlugin()]
  },
})

/**
 * Whether a suggestion menu (slash, mention) is open: its plugin comes later
 * and takes the arrow keys. Reads the `@tiptap/suggestion` plugin state
 * `{ active, range }`.
 */
function isSuggestionMenuOpen(state: EditorState): boolean {
  return state.plugins.some((plugin) => {
    const pluginState = plugin.getState(state) as { active?: unknown, range?: unknown } | undefined
    return pluginState?.active === true && pluginState.range !== undefined
  })
}

/**
 * Whether the text at `pos` has no rendered box, e.g. inside a
 * `display: none` element.
 */
function isPositionHidden(view: EditorView, pos: number): boolean {
  const { node } = view.domAtPos(pos)
  const element = node instanceof Element ? node : node.parentElement
  return element !== null && element.getClientRects().length === 0
}
