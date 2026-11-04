import Mention from '@tiptap/extension-mention'
import { mergeAttributes } from '@tiptap/core'

/**
 * Mention node — schema only (no Vue), reused by the server-side commit
 * schema.
 *
 * Storage form is the comark inline component `:mention[label]{uid="N"}`
 * (app/comark/pm-mapper.ts), so the Drupal uid survives save and reload.
 * `@name` text stays plain text — only the popover (or a parsed `:mention`
 * component) produces a mention node.
 *
 * The render options mirror what Nuxt UI's UEditor configures for its own
 * Mention copy (node_modules/@nuxt/ui/dist/runtime/components/Editor.vue);
 * the editor page passes this extension explicitly instead.
 */
export const OkbMention = Mention.configure({
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
