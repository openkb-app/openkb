import { Node } from '@tiptap/core'
import type { JSONContent } from '@tiptap/core'
import { MDC_PROPS_SOURCE, parseMdcProps, serializeMdcProps } from './mdc-markdown'

const BLOCK_FENCE = new RegExp(String.raw`^(:{2,})embed\{(${MDC_PROPS_SOURCE})\}[ \t]*(?:\n\1(?!:)[ \t]*(?:\n|$)|\n|$)`)

/**
 * A page file shown in the page: `::embed{file="<uuid>" title="…"}` + close
 * fence on the next line, childless like `::attachment`. HTML and PDF show in
 * a frame, any other file as its card (EmbedFrame.vue).
 *
 * Vue-free, so the server-side commit schema can load it; the NodeView is
 * layered on in app/editor/extensions.ts.
 */
export const OkbEmbed = Node.create({
  name: 'embed',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      file: { default: null },
      title: { default: null },
      id: { default: null },
    }
  },

  parseHTML() {
    return [{
      tag: 'div[data-type="embed"]',
      getAttrs: (element: HTMLElement) => ({
        file: element.getAttribute('data-file'),
        title: element.getAttribute('data-title'),
      }),
    }]
  },

  renderHTML({ node }) {
    return ['div', {
      'data-type': 'embed',
      'data-file': node.attrs.file ?? '',
      'data-title': node.attrs.title || undefined,
    }]
  },

  markdownTokenName: 'embed',
  markdownTokenizer: {
    name: 'embed',
    level: 'block',
    start(src: string) {
      const index = src.match(/^:{2,}embed\{/m)?.index
      return index !== undefined ? index : -1
    },
    tokenize(src) {
      const match = src.match(BLOCK_FENCE)
      if (!match) return undefined
      return { type: 'embed', raw: match[0], attributes: parseMdcProps(match[2] ?? '') }
    },
  },

  parseMarkdown(token, helpers) {
    const attributes = (token as { attributes?: Record<string, string> }).attributes ?? {}
    return helpers.createNode('embed', {
      file: attributes.file ?? null,
      title: attributes.title || null,
      id: attributes.id ?? null,
    })
  },

  renderMarkdown(node: JSONContent) {
    const attrs = (node.attrs ?? {}) as { file?: string | null, title?: string | null, id?: string | null }
    const props: Record<string, string> = {}
    if (attrs.file) props.file = attrs.file
    if (attrs.title) props.title = attrs.title
    if (attrs.id) props.id = attrs.id
    return `::embed{${serializeMdcProps(props)}}\n::`
  },
})
