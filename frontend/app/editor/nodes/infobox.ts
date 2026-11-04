import { Node, mergeAttributes } from '@tiptap/core'

/**
 * TipTap node for ::infobox{title="…"} comark fences — schema only (no NodeView).
 *
 * parseHTML / renderHTML are the editor's own clipboard shape, so an infobox
 * survives a copy-paste inside the editor. The read page renders
 * CustomInfobox's root instead, and a paste from there keeps the words but not
 * the infobox (see ./callout.test.ts).
 *
 * Carries NO Vue / NodeView imports so it can be reused by the server-side
 * commit schema (frontend/server/utils/editor-schema.ts). The live preview
 * NodeView is layered on in app/editor/extensions.ts via
 * `Infobox.extend({ addNodeView })`.
 */
export const Infobox = Node.create({
  name: 'infobox',
  group: 'block',
  content: 'block+',
  defining: true,

  /** The box's title and its block id. */
  addAttributes() {
    return {
      title: {
        default: '',
        /** Reads the title off the element's `title` attribute. */
        parseHTML: (element: HTMLElement) => element.getAttribute('title') ?? '',
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
        tag: 'custom-infobox',
      },
    ]
  },

  renderHTML({ HTMLAttributes }) {
    const title = (HTMLAttributes as { title?: string }).title ?? ''
    return ['custom-infobox', mergeAttributes({ title }), 0]
  },
})
