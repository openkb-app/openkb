import { Node } from '@tiptap/core'

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
})
