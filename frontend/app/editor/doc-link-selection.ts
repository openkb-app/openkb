import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'

/**
 * The words a document link is made of.
 *
 * A link opened on a selection is about the selected words: they become the
 * link's label and the link takes their place. Opened on a caret it carries
 * the target page's own title instead — there are no words to speak for it.
 *
 * Both openers put the same `[[` into the text: the one typed by hand, which
 * this extension watches for, and the one the toolbar and the slash menu
 * insert (editor/menu-items.ts). Each records the words its `[[` is about,
 * keyed on the position that `[[` landed at, and the picker reads the record
 * back when a target is chosen (editor/components/DocLinkMenu.vue).
 *
 * The key is what keeps an abandoned `[[` out of a later pick: a record whose
 * position no longer matches is dropped, and the label falls back to the
 * target's title — correct either way.
 */

/** The words a `[[` is about, and where they still sit. */
export interface LinkSelection {
  /** The selected words — the link's label. */
  text: string
  /**
   * The range the words still occupy, where the `[[` went after them. Null
   * where the `[[` took their place, as a hand-typed `[` does.
   */
  range: { from: number, to: number } | null
}

let consumed: (LinkSelection & { at: number }) | null = null

/** Records the words the `[[` at `at` is about. */
export function recordLinkSelection(
  text: string,
  at: number,
  range: { from: number, to: number } | null = null,
): void {
  consumed = text.trim() ? { text, range, at } : null
}

/** The words the `[[` at `at` is about. Reads once. */
export function takeLinkSelection(at: number): LinkSelection | null {
  const held = consumed
  consumed = null
  return held && held.at === at ? { text: held.text, range: held.range } : null
}

/**
 * Records the selection a hand-typed `[[` is about to swallow.
 *
 * The first `[` is an ordinary text input over a selection, so the words are
 * only readable here, before ProseMirror replaces them. The input itself is
 * left alone — this only remembers.
 */
export const DocLinkSelection = Extension.create({
  name: 'docLinkSelection',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('docLinkSelection'),
        props: {
          handleTextInput(view, from, to, text) {
            if (text === '[' && from < to) {
              recordLinkSelection(view.state.doc.textBetween(from, to, ' '), from)
            }
            return false
          },
        },
      }),
    ]
  },
})
