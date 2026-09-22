import { Node, mergeAttributes } from '@tiptap/core'
import type { JSONContent, MarkdownToken } from '@tiptap/core'
import { parseMdcProps, serializeMdcProps } from './mdc-markdown'
import { CITATION_TAG, citeTarget } from '#shared/utils/citations'

/**
 * A citation: schema and markdown only (no Vue), so the server-side commit
 * schema can reuse it.
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

  markdownTokenName: CITATION_TAG,

  markdownTokenizer: {
    name: CITATION_TAG,
    level: 'inline',
    start(src: string) {
      return src.indexOf(`:${CITATION_TAG}{`)
    },
    tokenize(src: string) {
      const match = src.match(new RegExp(`^:${CITATION_TAG}\\{([^}]*)\\}`))
      if (!match) return undefined
      // The shared MDC parser, so every quoting style comark accepts is read
      // here too.
      const target = citeTarget(parseMdcProps(match[1] ?? ''))
      if (!target) return undefined
      return {
        type: CITATION_TAG,
        raw: match[0],
        ...(target.kind === 'url'
          ? { url: target.url }
          : { nid: target.nid, block: target.block, v: target.v }),
      }
    },
  },

  parseMarkdown(token: MarkdownToken) {
    const { nid, block, v, url } = token as CiteAttrs
    return {
      type: CITATION_TAG,
      attrs: { nid: nid ?? null, block: block ?? null, v: v ?? null, url: url ?? null },
    }
  },

  renderMarkdown(node: JSONContent) {
    const target = citeTarget((node.attrs ?? {}) as Record<string, unknown>)
    // A citation naming no source has nothing to write.
    if (!target) return ''
    const props = target.kind === 'url'
      ? { url: target.url }
      : {
          nid: String(target.nid),
          ...(target.block ? { block: target.block } : {}),
          ...(target.v ? { v: target.v } : {}),
        }
    return `:${CITATION_TAG}{${serializeMdcProps(props)}}`
  },
})

interface CiteAttrs {
  nid?: number | null
  block?: string | null
  v?: string | null
  url?: string | null
}
