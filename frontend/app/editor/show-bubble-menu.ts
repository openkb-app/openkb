import type { Editor } from '@tiptap/core'
import type { PluginKey } from '@tiptap/pm/state'

/**
 * Shows the bubble menu of `key` and places it at its anchor.
 *
 * TipTap's `show` meta does not place a hidden menu: `transactionHandler` in
 * `bubble-menu-plugin.ts` positions before it shows, and `updatePosition()`
 * returns while hidden. The second dispatch places it.
 */
export function showAndPositionBubbleMenu(editor: Editor, key: PluginKey): void {
  editor.view.dispatch(editor.state.tr.setMeta(key, 'show'))
  editor.view.dispatch(editor.state.tr.setMeta(key, 'updatePosition'))
}
