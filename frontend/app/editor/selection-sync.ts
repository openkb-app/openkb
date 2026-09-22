import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { getRelativeSelection, ySyncPluginKey } from '@tiptap/y-tiptap'
import type { Transaction as YTransaction } from 'yjs'

/**
 * Keeps a caret move PM has not read yet. PM reads a click or caret key from
 * the DOM on `selectionchange`; a key handled before that, or a transaction
 * applied before that, would otherwise act on or restore the old selection.
 */

interface DOMSelectionRange {
  anchorNode: Node | null
  anchorOffset: number
  focusNode: Node | null
  focusOffset: number
}

/** Untyped but stable prosemirror-view internals. */
interface ViewInternals {
  domObserver?: {
    flush(): void
    pendingRecords(): unknown[]
    currentSelection: { eq(sel: DOMSelectionRange): boolean }
  }
  docView?: { dirty: number }
  domSelectionRange(): DOMSelectionRange
}

/**
 * Views the user pressed a key or the mouse in since they last took focus.
 * Before that, a DOM selection change is the browser placing the caret on a
 * programmatic focus, which PM corrects itself.
 */
const userInput = new WeakSet<EditorView>()

/**
 * Lets PM read a DOM selection change it has not read yet. Pending DOM
 * mutations are read only after the current task's code: reading them now
 * would change the document under a transaction built against it.
 */
export function readUnreadSelection(view: EditorView): void {
  const internals = view as unknown as ViewInternals
  const { domObserver: observer, docView } = internals
  if (!userInput.has(view) || !observer || !docView || docView.dirty || view.composing || !view.hasFocus()) return
  if (observer.currentSelection.eq(internals.domSelectionRange())) return
  // Taking the records stops the observer from delivering them, so flush
  // them in a microtask, as the observer would.
  if (observer.pendingRecords().length) return queueMicrotask(() => observer.flush())
  observer.flush()
}

export const SelectionKeydownSync = Extension.create({
  name: 'selectionKeydownSync',

  // The view writes the state selection back over the DOM one on update.
  dispatchTransaction({ transaction: tr, next }) {
    const { view } = this.editor
    if (!tr.selectionSet && !tr.getMeta(ySyncPluginKey) && tr.before === view.state.doc) {
      const before = view.state.selection
      readUnreadSelection(view)
      // Reading the selection can change the document, e.g. by an appended
      // transaction. The transaction no longer applies then and is dropped,
      // as PM drops a filtered one.
      if (view.state.doc !== tr.before) return
      const read = view.state.selection
      if (read !== before) tr.setSelection(read.map(tr.doc, tr.mapping))
    }
    next(tr)
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('selectionKeydownSync'),

        // A remote update replaces the whole document; y-tiptap restores the
        // selection from what it records when the Y transaction starts.
        view(view) {
          const binding = ySyncPluginKey.getState(view.state)?.binding
          const recordUnread = (transaction: YTransaction) => {
            if (transaction.origin === ySyncPluginKey) return
            const before = view.state.selection
            readUnreadSelection(view)
            if (view.state.selection !== before) {
              binding.beforeTransactionSelection = getRelativeSelection(binding, view.state)
            }
          }
          binding?.doc.on('beforeTransaction', recordUnread)
          return { destroy: () => binding?.doc.off('beforeTransaction', recordUnread) }
        },

        props: {
          handleDOMEvents: {
            // PM handles some keys before its `selectionchange` read.
            keydown: (view, event) => {
              if (event.isComposing || event.keyCode === 229 || view.composing) return false
              ;(view as unknown as ViewInternals).domObserver?.flush()
              userInput.add(view)
              return false
            },
            mousedown: (view) => {
              userInput.add(view)
              return false
            },
            blur: (view) => {
              userInput.delete(view)
              return false
            },
          },
        },
      }),
    ]
  },
})
