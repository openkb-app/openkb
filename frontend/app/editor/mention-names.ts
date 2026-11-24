import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as ProseNode } from '@tiptap/pm/model'
import { accountName, accountUnknown, onAccountNames, requestAccountName } from '../composables/useAccountNames'

/** The plugin state: the decorations naming the document's mentions. */
export const MENTION_NAMES_KEY = new PluginKey<DecorationSet>('mentionNames')

/** The meta a transaction carries when names arrived, not the document. */
const NAMES_ARRIVED = 'namesArrived'

/** Decorates every mention whose account's current name is known, or that names no account. */
export function decorateMentionNames(doc: ProseNode): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'mention') return
    const uid = Number(node.attrs.id)
    requestAccountName(uid)
    const name = accountName(uid)
    if (name !== undefined) {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { 'data-current-label': name }))
    }
    else if (accountUnknown(uid)) {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'mention--unknown' }))
    }
    return false
  })
  return DecorationSet.create(doc, decorations)
}

/**
 * The current account names the editor draws on its mention chips.
 *
 * - A mention stores a uid and the label it was written with; the chip
 *   names the account as it is called now, the way the read page's
 *   `Mention.vue` does.
 * - Set as a node decoration (`data-current-label`); `main.css` draws it in
 *   place of the stored label.
 * - The stored label shows until the name is known.
 * - A mention of an account the lookup does not know (gone, or hidden)
 *   reads as plain text (`mention--unknown`), as in `Mention.vue`.
 */
export const MentionNames = Extension.create({
  name: 'mentionNames',

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: MENTION_NAMES_KEY,
        state: {
          init: (_config, state) => decorateMentionNames(state.doc),
          apply: (tr, value) => (tr.docChanged || tr.getMeta(MENTION_NAMES_KEY) === NAMES_ARRIVED
            ? decorateMentionNames(tr.doc)
            : value),
        },
        props: {
          decorations(state) {
            return MENTION_NAMES_KEY.getState(state)
          },
        },
        view(view) {
          const stop = onAccountNames(() => {
            if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(MENTION_NAMES_KEY, NAMES_ARRIVED))
          })
          return { destroy: stop }
        },
      }),
    ]
  },
})
