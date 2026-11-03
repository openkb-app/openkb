import { TrailingNode } from '@tiptap/extensions'
import { Plugin } from '@tiptap/pm/state'
import type { Transaction } from '@tiptap/pm/state'
import { ySyncPluginKey } from '@tiptap/y-tiptap'
import type * as Y from 'yjs'

interface YSyncState {
  doc: Y.Doc
  binding: { mux: (f: () => void) => void }
}

/**
 * TipTap's trailing node, kept out of the collaborative undo history.
 *
 * After a change from Y (the page loading, an undo) y-sync writes the appended
 * paragraph to Y only with the next transaction. Tracked, that write joins the
 * next keystroke's undo step, or clears the redo stack. So that append:
 * - is `addToHistory: false`, which the UndoManager skips;
 * - goes to Y as soon as the Y change is done, before any user edit.
 */
export const CollabTrailingNode = TrailingNode.extend({
  addProseMirrorPlugins() {
    let pending = false
    return [
      ...(this.parent?.() ?? []).map(plugin => new Plugin({
        ...plugin.spec,
        appendTransaction: (transactions, oldState, newState) => {
          const tr = plugin.spec.appendTransaction?.(transactions, oldState, newState)
          if (tr && transactions.some(isFromY)) {
            pending = true
            tr.setMeta('addToHistory', false)
          }
          return tr
        },
      })),
      new Plugin({
        view: (view) => {
          const ystate = ySyncPluginKey.getState(view.state) as YSyncState | undefined
          if (!ystate) {
            return {}
          }
          const flush = () => {
            if (pending && !syncing(ystate)) {
              pending = false
              // y-sync writes on any transaction, flagged as the last doc change was.
              view.dispatch(view.state.tr)
            }
          }
          ystate.doc.on('afterAllTransactions', flush)
          // Content already in Y rendered while the sync plugin's view was built.
          flush()
          return { destroy: () => ystate.doc.off('afterAllTransactions', flush) }
        },
      }),
    ]
  },
})

function isFromY(tr: Transaction): boolean {
  return !!tr.getMeta(ySyncPluginKey)?.isChangeOrigin
}

/** Whether y-sync is mid-write, when it writes nothing back. */
function syncing({ binding }: YSyncState): boolean {
  let free = false
  binding.mux(() => {
    free = true
  })
  return !free
}
