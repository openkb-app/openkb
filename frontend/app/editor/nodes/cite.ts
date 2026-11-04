import { Node, mergeAttributes } from '@tiptap/core'
import { CITATION_TAG } from '#shared/utils/citations'

/**
 * A citation: schema only (no Vue), so the server-side commit schema can
 * reuse it.
 *
 * Stored as the comark inline component `:citation{nid="42" block="b-4f2a"
 * v="9c1f0a…"}` or `:citation{url="https://…"}` (#shared/utils/citations.ts). An
 * atom carrying no words: what a reader sees is a number, and the number is
 * assigned where the page is rendered. The editor draws the chip from the
 * attributes through a decoration (app/editor/cite-numbers.ts).
 */
export const OkbCite = Node.create({
  name: CITATION_TAG,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      nid: { default: null },
      block: { default: null },
      v: { default: null },
      url: { default: null },
    }
  },

  parseHTML() {
    return [{
      tag: `span[data-type="${CITATION_TAG}"]`,
      getAttrs: (element: HTMLElement) => ({
        nid: Number(element.getAttribute('data-nid')) || null,
        block: element.getAttribute('data-block'),
        v: element.getAttribute('data-v'),
        url: element.getAttribute('data-url'),
      }),
    }]
  },

  renderHTML({ node }) {
    const { nid, block, v, url } = node.attrs as CiteAttrs
    return [
      'span',
      mergeAttributes({
        'data-type': CITATION_TAG,
        'data-nid': nid === null || nid === undefined ? undefined : String(nid),
        'data-block': block ?? undefined,
        'data-v': v ?? undefined,
        'data-url': url ?? undefined,
        'class': 'okb-cite',
      }),
    ]
  },

  renderText() {
    return ''
  },
})

interface CiteAttrs {
  nid?: number | null
  block?: string | null
  v?: string | null
  url?: string | null
}
