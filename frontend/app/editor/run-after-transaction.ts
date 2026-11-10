import type * as Y from 'yjs'

/**
 * Runs `run` after each Y transaction that changed `type`.
 *
 * It runs once every observer of that transaction has run, the editor's
 * render of the fragment included. y-tiptap writes the editor's document back
 * to the fragment on every dispatch, so a dispatch from an observer of `type`
 * would write a document that does not yet hold the fragment changes of the
 * same transaction, and delete them.
 *
 * @returns A function that stops it.
 */
export function runAfterTransactionsThatChange(ydoc: Y.Doc, type: Y.AbstractType<unknown>, run: () => void): () => void {
  /** Runs `run` when this transaction changed `type`. */
  const runIfChanged = (transaction: Y.Transaction) => {
    if (transaction.changed.has(type)) run()
  }
  ydoc.on('afterTransaction', runIfChanged)
  return () => ydoc.off('afterTransaction', runIfChanged)
}
