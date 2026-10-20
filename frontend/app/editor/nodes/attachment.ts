import { Node } from '@tiptap/core'
import type { JSONContent } from '@tiptap/core'
import { MDC_PROPS_SOURCE, parseMdcProps, serializeMdcProps } from './mdc-markdown'
import { docLinkLabel } from './doc-link'

const BLOCK_FENCE = new RegExp(String.raw`^(:{2,})attachment\{(${MDC_PROPS_SOURCE})\}[ \t]*(?:\n\1(?!:)[ \t]*(?:\n|$)|\n|$)`)
const INLINE_FENCE = new RegExp(String.raw`^:attachment(?:\[([^\]]*)\])?\{(${MDC_PROPS_SOURCE})\}`)

/**
 * A page file on the page (ADR 0020): `::attachment{file="<uuid>"}` + close
 * fence on the next line, a childless MDC fence like `::image`. It renders as
 * the file card; name, size and type are resolved per reader, never stored.
 * An optional `description` shows on the card.
 *
 * Vue-free, so the server-side commit schema can load it; the NodeView is
 * layered on in app/editor/extensions.ts.
 */
export const OkbAttachment = Node.create({
  name: 'attachment',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      file: { default: null },
      description: { default: null },
      id: { default: null },
    }
  },

  parseHTML() {
    return [{
      tag: 'div[data-type="attachment"]',
      getAttrs: (element: HTMLElement) => ({
        file: element.getAttribute('data-file'),
        description: element.getAttribute('data-description'),
      }),
    }]
  },

  renderHTML({ node }) {
    return ['div', {
      'data-type': 'attachment',
      'data-file': node.attrs.file ?? '',
      'data-description': node.attrs.description || undefined,
    }]
  },

  markdownTokenName: 'attachment',
  markdownTokenizer: {
    name: 'attachment',
    level: 'block',
    start(src: string) {
      const index = src.match(/^:{2,}attachment\{/m)?.index
      return index !== undefined ? index : -1
    },
    tokenize(src) {
      // Same shape as the image fence: props on the open line, the close
      // fence (the opener's colon count alone) on the next.
      const match = src.match(BLOCK_FENCE)
      if (!match) return undefined
      return { type: 'attachment', raw: match[0], attributes: parseMdcProps(match[2] ?? '') }
    },
  },

  parseMarkdown(token, helpers) {
    const attributes = (token as { attributes?: Record<string, string> }).attributes ?? {}
    return helpers.createNode('attachment', {
      file: attributes.file ?? null,
      description: attributes.description || null,
      id: attributes.id ?? null,
    })
  },

  renderMarkdown(node: JSONContent) {
    const attrs = (node.attrs ?? {}) as { file?: string | null, description?: string | null, id?: string | null }
    const props: Record<string, string> = {}
    if (attrs.file) props.file = attrs.file
    if (attrs.description) props.description = attrs.description
    if (attrs.id) props.id = attrs.id
    return `::attachment{${serializeMdcProps(props)}}\n::`
  },
})

/**
 * The inline form, a download link inside a sentence:
 * `:attachment[Label]{file="<uuid>"}`, or `:attachment{file="<uuid>"}` named by
 * the file. An atom like the page link: the label is fixed words, retargeting
 * means picking again.
 */
export const OkbAttachmentInline = Node.create({
  name: 'attachmentInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return { file: { default: null }, label: { default: '' } }
  },

  parseHTML() {
    return [{
      tag: 'span[data-type="attachment"]',
      getAttrs: (element: HTMLElement) => ({
        file: element.getAttribute('data-file'),
        label: element.getAttribute('data-label') ?? '',
      }),
    }]
  },

  renderHTML({ node }) {
    const { file, label } = node.attrs as AttachmentLinkAttrs
    return ['span', { 'data-type': 'attachment', 'data-file': file ?? '', 'data-label': label || undefined }, label ?? '']
  },

  renderText({ node }) {
    return (node.attrs as AttachmentLinkAttrs).label ?? ''
  },

  markdownTokenName: 'attachmentInline',
  markdownTokenizer: {
    name: 'attachmentInline',
    level: 'inline',
    start(src: string) {
      return src.search(/:attachment[[{]/)
    },
    tokenize(src: string) {
      const match = src.match(INLINE_FENCE)
      if (!match) return undefined
      return { type: 'attachmentInline', raw: match[0], label: match[1] ?? '', attributes: parseMdcProps(match[2] ?? '') }
    },
  },

  parseMarkdown(token, helpers) {
    const { attributes = {}, label = '' } = token as { attributes?: Record<string, string>, label?: string }
    return helpers.createNode('attachmentInline', { file: attributes.file ?? null, label })
  },

  renderMarkdown(node: JSONContent) {
    const { file, label } = (node.attrs ?? {}) as AttachmentLinkAttrs
    const words = docLinkLabel(label ?? '')
    if (!file) return words
    return words ? `:attachment[${words}]{${serializeMdcProps({ file })}}` : `:attachment{${serializeMdcProps({ file })}}`
  },
})

interface AttachmentLinkAttrs {
  file?: string | null
  label?: string | null
}
