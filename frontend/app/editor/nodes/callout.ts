import { Node, mergeAttributes } from '@tiptap/core'
import { mdcFenceTokenizer, parseMdcFence, renderMdcFence } from './mdc-markdown'

export const CALLOUT_TYPES = ['info', 'warning', 'success', 'danger'] as const
export type CalloutType = typeof CALLOUT_TYPES[number]

/**
 * TipTap Node for the Callout component — schema only (no NodeView).
 *
 * parseHTML / renderHTML are the editor's own clipboard shape, so a callout
 * survives a copy-paste inside the editor. The read page renders
 * CustomCallout's root instead, and a paste from there keeps the words but not
 * the callout (see ./callout.test.ts).
 *
 * This module carries NO Vue / NodeView imports so it can be pulled into the
 * server-side commit schema (frontend/server/utils/editor-schema.ts) in a
 * plain Node context. The live preview NodeView is layered on top in
 * app/editor/extensions.ts via `Callout.extend({ addNodeView })`. The
 * markdown grammar (::callout{type="…"} fences, both directions) lives on
 * the node itself — see ./mdc-markdown.ts.
 */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      type: {
        default: 'info',
      },
      // Stable block id (`{#b-…}` fence shorthand) — carried through the
      // markdown round-trip; OKB-25 builds on it.
      id: {
        default: null,
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'custom-callout',
        getAttrs: (element: HTMLElement) => {
          const value = element.getAttribute('type')
          return {
            type: CALLOUT_TYPES.includes(value as CalloutType) ? value : 'info',
          }
        },
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    const type = (HTMLAttributes as { type?: string }).type ?? 'info'
    return ['custom-callout', mergeAttributes({ type }), 0]
  },

  markdownTokenName: 'callout',
  markdownTokenizer: mdcFenceTokenizer('callout'),
  parseMarkdown: parseMdcFence('callout', { type: 'info' }),
  renderMarkdown(node, helpers) {
    const attrs = node.attrs as { type?: string, id?: string | null } | undefined
    const type = CALLOUT_TYPES.includes(attrs?.type as CalloutType) ? attrs!.type! : 'info'
    return renderMdcFence('callout', node, helpers, attrs?.id ? { type, id: attrs.id } : { type })
  },
})
