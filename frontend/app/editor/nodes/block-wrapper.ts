import { Node } from '@tiptap/core'
import type { JSONContent, MarkdownParseHelpers, MarkdownToken } from '@tiptap/core'
import { mdcFenceTokenizer, renderMdcFence } from './mdc-markdown'

/**
 * The generic id-bearing wrapper fence: `::block{#b-…}` … `::`.
 *
 * Blocks comark has no attribute syntax for — tables, lists, code fences,
 * blockquotes, rules — carry their review id by riding inside this fence in
 * the serialized markdown. The node exists ONLY at the serialization
 * boundary: lowerBlockIds wraps an id-carrying container on the way out,
 * liftBlockIds unwraps the fence onto the inner node's `attrs.id` on the way
 * in, so the live editor document never holds one (see
 * shared/page-blocks.ts).
 *
 * Named `blockWrapper` because a node named `block` would shadow the
 * ProseMirror group of the same name in every `block+` content expression.
 */
export const BlockWrapper = Node.create({
  name: 'blockWrapper',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      id: {
        default: null,
      },
    }
  },

  parseHTML() {
    return [{ tag: 'custom-block' }]
  },

  renderHTML() {
    return ['custom-block', 0]
  },

  markdownTokenName: 'block',
  markdownTokenizer: mdcFenceTokenizer('block'),
  parseMarkdown(token: MarkdownToken, helpers: MarkdownParseHelpers): JSONContent {
    return {
      type: 'blockWrapper',
      attrs: { ...(token as { attributes?: Record<string, string> }).attributes },
      content: helpers.parseChildren(token.tokens ?? []),
    }
  },
  renderMarkdown(node, helpers) {
    const id = (node.attrs as { id?: string | null } | undefined)?.id
    return renderMdcFence('block', node, helpers, id ? { id } : {})
  },
})
