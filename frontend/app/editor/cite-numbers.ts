import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as ProseNode } from '@tiptap/pm/model'
import { CITATION_TAG, citeKey, citeTarget } from '#shared/utils/citations'

/**
 * The numbers the editor draws on its citation chips.
 *
 * A citation stores a target, never a number, so the number is worked out
 * wherever the document is rendered — here as a node decoration, on the read
 * page in the tree pass (#shared/utils/comark-tree.ts). Both count the same
 * way: distinct targets in document order, so two citations of one block are
 * one number.
 *
 * `main.css` draws the chip from the `data-n` this sets.
 */
export const CITE_NUMBERS_KEY = new PluginKey<DecorationSet>('citeNumbers')

/** Block id → the number its target holds, in document order. */
export function citeNumbers(doc: ProseNode): Map<number, number> {
  const numbers = new Map<string, number>()
  const byPos = new Map<number, number>()
  doc.descendants((node, pos) => {
    if (node.type.name !== CITATION_TAG) return
    const target = citeTarget(node.attrs as Record<string, unknown>)
    if (!target) return
    const key = citeKey(target)
    const n = numbers.get(key) ?? numbers.size + 1
    numbers.set(key, n)
    byPos.set(pos, n)
  })
  return byPos
}

function decorate(doc: ProseNode): DecorationSet {
  const decorations: Decoration[] = []
  for (const [pos, n] of citeNumbers(doc)) {
    const node = doc.nodeAt(pos)
    if (!node) continue
    decorations.push(Decoration.node(pos, pos + node.nodeSize, {
      'data-n': String(n),
      'role': 'note',
      'aria-label': `Citation ${n}`,
    }))
  }
  return DecorationSet.create(doc, decorations)
}

export const CiteNumbers = Extension.create({
  name: 'citeNumbers',

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: CITE_NUMBERS_KEY,
        state: {
          init: (_config, state) => decorate(state.doc),
          apply: (tr, value) => (tr.docChanged ? decorate(tr.doc) : value),
        },
        props: {
          decorations(state) {
            return CITE_NUMBERS_KEY.getState(state)
          },
        },
      }),
    ]
  },
})
