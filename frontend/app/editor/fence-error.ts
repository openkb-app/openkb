import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { fenceFor } from '#shared/utils/fences'

/** Which fence's source to mark: the code block's position, and its refused line (0 clears). */
export interface FenceErrorMeta {
  pos: number
  line: number
}

export const fenceErrorKey = new PluginKey<DecorationSet>('okbFenceError')

/**
 * Marks the refused line in a fence component's source. The node view reports
 * each draw's result (`CodeBlockNodeView`); the mark moves with edits until
 * the next report replaces it, and goes once its block is no longer a fence.
 */
export function fenceErrorPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: fenceErrorKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        const mapped = set.map(tr.mapping, tr.doc)
        const next = tr.docChanged ? withoutStale(mapped, tr) : mapped
        const meta = tr.getMeta(fenceErrorKey) as FenceErrorMeta | undefined
        return meta ? withLine(next, tr, meta) : next
      },
    },
    props: {
      decorations: state => fenceErrorKey.getState(state),
    },
  })
}

/** The block's marks replaced by one over the refused line. */
function withLine(set: DecorationSet, tr: Transaction, { pos, line }: FenceErrorMeta): DecorationSet {
  const node = tr.doc.nodeAt(pos)
  if (!node) return set
  const end = pos + node.nodeSize
  const cleared = set.remove(set.find(pos, end))
  const lines = node.textContent.split('\n')
  if (line < 1 || line > lines.length) return cleared
  let from = pos + 1
  for (let i = 0; i < line - 1; i++) from += lines[i]!.length + 1
  const to = from + lines[line - 1]!.length
  // An empty line has no text to mark; the error message still names it.
  if (to === from) return cleared
  return cleared.add(tr.doc, [Decoration.inline(from, to, { class: 'okb-code-errline' })])
}

/** The marks whose block is no fence any more: another language, another node type. */
function withoutStale(set: DecorationSet, tr: Transaction): DecorationSet {
  const stale = set.find().filter((mark) => {
    const block = tr.doc.resolve(mark.from).parent
    return block.type.name !== 'codeBlock' || !fenceFor(String(block.attrs.language ?? ''))
  })
  return stale.length ? set.remove(stale) : set
}
