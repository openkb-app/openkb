import type { EditorView } from '@tiptap/pm/view'

/** Reads a widget's document position; undefined once it has left the document. */
type WidgetPosition = () => number | undefined

/** Draws a widget's DOM, the way ProseMirror's `Decoration.widget` takes it. */
type WidgetDrawing = (view: EditorView, getPos: WidgetPosition) => HTMLElement

/**
 * Makes a widget decoration draw one DOM node for as long as it lives.
 *
 * ProseMirror redraws a widget whenever the text beside it is typed in. Handed
 * the node it already holds, it leaves the DOM as it is, so a keystroke writes
 * nothing but its character.
 */
export function widgetDrawnOncePerDecoration(draw: WidgetDrawing): WidgetDrawing {
  let dom: HTMLElement | undefined
  let currentPosition: WidgetPosition
  return (view, getPos) => {
    // Each redraw brings the position reader of the view desc now holding the node.
    currentPosition = getPos
    dom ??= draw(view, () => currentPosition())
    return dom
  }
}
