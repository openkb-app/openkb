import { Node } from '@tiptap/core'

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
})

interface AttachmentLinkAttrs {
  file?: string | null
  label?: string | null
}
