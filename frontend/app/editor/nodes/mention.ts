import Mention from '@tiptap/extension-mention'
import { mergeAttributes } from '@tiptap/core'
import type { JSONContent, MarkdownToken } from '@tiptap/core'
import { parseMdcProps } from './mdc-markdown'

/**
 * Mention node with comark markdown round-trip — schema + markdown only
 * (no Vue), reused by the server-side commit schema.
 *
 * Storage form is the comark inline component `:mention[label]{uid="N"}`,
 * so the Drupal uid survives save+reload (plain `@label` prose kept the
 * name but lost the uid). Legacy `@name` text stays plain text — only the
 * popover (or a parsed `:mention` component) produces a mention node.
 *
 * The render options mirror what Nuxt UI's UEditor configures for its own
 * Mention copy (node_modules/@nuxt/ui/dist/runtime/components/Editor.vue);
 * the editor page passes this extension explicitly instead.
 */
export const OkbMention = Mention.extend({
  markdownTokenName: 'mention',

  markdownTokenizer: {
    name: 'mention',
    level: 'inline',
    start(src: string) {
      return src.indexOf(':mention[')
    },
    tokenize(src: string) {
      const match = src.match(/^:mention\[([^\]]*)\]\{([^}]*)\}/)
      if (!match) return undefined
      // Props go through the shared MDC parser so every quoting style
      // comark accepts is read here too (see ./mdc-markdown.ts).
      const uid = parseMdcProps(match[2] ?? '').uid
      if (uid === undefined || !/^\d+$/.test(uid)) return undefined
      return {
        type: 'mention',
        raw: match[0],
        label: match[1]!,
        uid,
      }
    },
  },

  parseMarkdown(token: MarkdownToken) {
    const { label, uid } = token as { label?: string, uid?: string }
    return {
      type: 'mention',
      attrs: { id: Number(uid), label: label ?? '' },
    }
  },

  renderMarkdown(node: JSONContent) {
    const { id, label } = (node.attrs ?? {}) as { id?: number | string | null, label?: string | null }
    const name = label ?? String(id ?? '')
    // No uid to preserve — plain prose keeps the document readable.
    if (id === null || id === undefined || id === '') return `@${name}`
    return `:mention[${name}]{uid="${id}"}`
  },
}).configure({
  HTMLAttributes: { class: 'mention' },
  renderText({ node }) {
    return `${node.attrs.mentionSuggestionChar ?? '@'}${node.attrs.label ?? node.attrs.id}`
  },
  renderHTML({ options, node }) {
    return [
      'span',
      mergeAttributes({ 'data-type': 'mention' }, options.HTMLAttributes),
      `${node.attrs.mentionSuggestionChar ?? '@'}${node.attrs.label ?? node.attrs.id}`,
    ]
  },
})
