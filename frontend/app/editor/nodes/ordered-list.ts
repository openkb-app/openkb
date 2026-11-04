import { OrderedList, parsePlainTextOrderedListPaste } from '@tiptap/extension-list'
import { Plugin } from '@tiptap/pm/state'
import type { Attributes } from '@tiptap/core'

/** A plain-text line a digit list is made of. */
const DIGIT_LIST_LINE = /^\s*\d+[.)]\s/

/**
 * A digit list only, as markdown holds:
 * - no `type` attribute: `<ol type="a">` and Google Docs/Word
 *   `list-style-type` paste as a digit list;
 * - plain-text paste: only digit markers become a list, `a) …` stays text.
 *
 * Vue-free, shared by the live editor and the commit schema.
 */
export const OkbOrderedList = OrderedList.extend({
  /** Returns the list's attributes without `type`. */
  addAttributes() {
    const { type: _type, ...attributes } = (this.parent?.() ?? {}) as Attributes
    return attributes
  },
  /** Adds the paste handler that turns only digit-marker lines into a list. */
  addProseMirrorPlugins() {
    return [new Plugin({
      props: {
        /** Pastes plain text of digit-marker lines as an ordered list; leaves anything else to the editor. */
        handlePaste: (view, event) => {
          if (event.clipboardData?.getData('text/html')?.trim()) return false
          const text = event.clipboardData?.getData('text/plain') ?? ''
          if (!text.split('\n').filter(line => line.trim()).every(line => DIGIT_LIST_LINE.test(line))) return false
          const list = parsePlainTextOrderedListPaste(text)
          if (!list) return false
          view.dispatch(view.state.tr.replaceSelectionWith(view.state.schema.nodeFromJSON(list)))
          return true
        },
      },
    })]
  },
})
