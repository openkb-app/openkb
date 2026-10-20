import type { Editor } from '@tiptap/core'
import type { Transaction } from '@tiptap/pm/state'

/** A range followed through later edits; null once its words are deleted. */
export interface TrackedRange {
  current: () => { from: number, to: number } | null
  stop: () => void
}

/**
 * Follows `from`–`to` through every later transaction, e.g. while an upload
 * runs. With Collaboration, `editor.utils` maps a peer edit or a Yjs undo by
 * Y relative position: y-tiptap applies those as a whole-document replace,
 * which PM mapping cannot follow.
 */
export function trackRange(editor: Editor, from: number, to = from): TrackedRange {
  let start = editor.utils.createMappablePosition(from)
  let end = editor.utils.createMappablePosition(to)
  let gone = false
  const map = ({ transaction }: { transaction: Transaction }) => {
    start = editor.utils.getUpdatedPosition(start, transaction).position
    end = editor.utils.getUpdatedPosition(end, transaction).position
    if (from < to && end.position <= start.position) gone = true
  }
  editor.on('transaction', map)
  return {
    current: () => (gone ? null : { from: start.position, to: Math.max(start.position, end.position) }),
    stop: () => editor.off('transaction', map),
  }
}
