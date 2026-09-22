import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { yUndoPluginKey } from '@tiptap/y-tiptap'
import type * as Y from 'yjs'

/**
 * Keeps the collaborative undo redoable.
 *
 * Undo/redo are the Y.js UndoManager's, and an undo is only redoable if the
 * manager tracks the transaction its own undo writes — which it does by holding
 * itself in `trackedOrigins`. Tiptap's Collaboration extension restores that
 * entry after a plugin-view teardown from a snapshot the teardown takes, and
 * keeps only the last snapshot. This editor ends up with two live views of the
 * undo plugin (a plugin view dispatches while the view list is being rebuilt,
 * and the re-entrant rebuild leaves the list with a second copy of every view),
 * so the views tear down back to back: the first teardown's snapshot has the
 * entry, the second one — taken after the first already cleared it — does not,
 * and that is the one replayed.
 *
 * So re-assert it on every plugin view this editor builds. Adding is idempotent
 * and never competes with the restore, which only ever adds.
 */
export const CollabHistory = Extension.create({
  name: 'collabHistory',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('collabHistory'),
        view: (view) => {
          const state = yUndoPluginKey.getState(view.state) as { undoManager: Y.UndoManager } | undefined
          const undoManager = state?.undoManager
          if (undoManager) undoManager.trackedOrigins.add(undoManager)
          return {}
        },
      }),
    ]
  },
})
