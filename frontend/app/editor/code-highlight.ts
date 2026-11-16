import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { Node as ProseNode } from '@tiptap/pm/model'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { loadCodeLanguage, tokenize, type CodeLine } from '#shared/utils/code-highlight'

interface HighlightState {
  set: DecorationSet
  /** Languages the document's code blocks name that are not loaded yet. */
  pending: Set<string>
  /** Token lines of this build's blocks, by language and text: the next build reuses them. */
  lines: Map<string, CodeLine[]>
}

export const codeHighlightKey = new PluginKey<HighlightState>('okbCodeHighlight')

/**
 * Colours the code blocks of a document with inline decorations, the token
 * classes and theme variables the read view's `HighlightedCodeBlock` renders.
 *
 * - A block whose language is not loaded yet stays plain; the plugin loads it
 *   and redraws once it is in.
 * - Each build tokenizes only blocks whose language or text is not in the
 *   previous build, so a keystroke re-tokenizes the block it changed.
 */
export function codeHighlightPlugin(nodeName = 'codeBlock'): Plugin<HighlightState> {
  function build(doc: ProseNode, previous?: Map<string, CodeLine[]>): HighlightState {
    const decorations: Decoration[] = []
    const pending = new Set<string>()
    const lines = new Map<string, CodeLine[]>()
    doc.descendants((node, pos) => {
      if (node.type.name !== nodeName) return true
      const language = String(node.attrs.language ?? '')
      const key = `${language}\u0000${node.textContent}`
      const blockLines = lines.get(key) ?? previous?.get(key) ?? tokenize(node.textContent, language)
      if (!blockLines) {
        pending.add(language)
        return false
      }
      lines.set(key, blockLines)
      decorations.push(...lineDecorations(blockLines, pos + 1))
      return false
    })
    return { set: DecorationSet.create(doc, decorations), pending, lines }
  }

  return new Plugin<HighlightState>({
    key: codeHighlightKey,
    state: {
      init: (_, state) => build(state.doc),
      apply: (tr, value, _old, state) => (tr.docChanged || tr.getMeta(codeHighlightKey) ? build(state.doc, value.lines) : value),
    },
    props: {
      decorations: state => codeHighlightKey.getState(state)?.set,
    },
    view(view) {
      let destroyed = false
      const requested = new Set<string>()
      const load = () => {
        for (const language of codeHighlightKey.getState(view.state)?.pending ?? []) {
          if (requested.has(language)) continue
          requested.add(language)
          void loadCodeLanguage(language).then((ok) => {
            if (ok && !destroyed) view.dispatch(view.state.tr.setMeta(codeHighlightKey, true))
          })
        }
      }
      load()
      return {
        update: load,
        destroy: () => {
          destroyed = true
        },
      }
    },
  })
}

/** One inline decoration per styled token; lines are joined by one `\n` each. */
function lineDecorations(lines: CodeLine[], start: number): Decoration[] {
  const out: Decoration[] = []
  let pos = start
  lines.forEach((line, i) => {
    if (i > 0) pos += 1
    for (const token of line) {
      const end = pos + token.content.length
      if (token.style) out.push(Decoration.inline(pos, end, { class: 'okb-code-token', style: token.style }))
      pos = end
    }
  })
  return out
}
