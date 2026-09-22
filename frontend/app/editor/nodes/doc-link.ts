import { Node, mergeAttributes } from '@tiptap/core'
import type { JSONContent, MarkdownToken } from '@tiptap/core'
import { parseMdcProps } from './mdc-markdown'
import { DOC_LINK_TAG, docLinkTarget } from '#shared/utils/doc-links'

/**
 * A link to another page: schema and markdown only (no Vue), so the
 * server-side commit schema can reuse it.
 *
 * Stored as the comark inline component `:doc[Label]{nid="42"}`, optionally
 * with `block="b-4f2a"` (#shared/utils/doc-links.ts). An atom: the label is
 * the target's name, not prose, so retargeting means picking again. The editor
 * shows the stored label, which is the rendering every reader is guaranteed to
 * see (server/utils/doc-links.ts).
 */
export const OkbDocLink = Node.create({
  name: 'docLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      nid: { default: null },
      block: { default: null },
      label: { default: '' },
    }
  },

  parseHTML() {
    const attrs = (element: HTMLElement) => ({
      nid: Number(element.getAttribute('data-nid')) || null,
      block: element.getAttribute('data-block'),
      label: element.textContent ?? '',
    })
    return [
      { tag: 'span[data-type="doc-link"]', getAttrs: attrs },
      // Matches the read page's own anchor, so a pasted copy keeps its target.
      // Priority beats the link mark's `a[href]`, which matches it too.
      { tag: 'a.okb-doc-link[data-nid]', priority: 100, getAttrs: attrs },
    ]
  },

  renderHTML({ node }) {
    const { nid, block, label } = node.attrs as DocLinkAttrs
    return [
      'span',
      mergeAttributes({
        'data-type': 'doc-link',
        'data-nid': nid === null ? undefined : String(nid),
        'data-block': block ?? undefined,
        'class': 'okb-doc-link',
      }),
      label ?? '',
    ]
  },

  renderText({ node }) {
    return (node.attrs as DocLinkAttrs).label ?? ''
  },

  markdownTokenName: 'docLink',

  markdownTokenizer: {
    name: 'docLink',
    level: 'inline',
    start(src: string) {
      return src.indexOf(`:${DOC_LINK_TAG}[`)
    },
    tokenize(src: string) {
      const match = src.match(new RegExp(`^:${DOC_LINK_TAG}\\[([^\\]]*)\\]\\{([^}]*)\\}`))
      if (!match) return undefined
      // The shared MDC parser, so every quoting style comark accepts is read
      // here too.
      const target = docLinkTarget(parseMdcProps(match[2] ?? ''))
      if (!target) return undefined
      return {
        type: 'docLink',
        raw: match[0],
        label: match[1]!,
        nid: target.nid,
        block: target.block,
      }
    },
  },

  parseMarkdown(token: MarkdownToken) {
    const { label, nid, block } = token as { label?: string, nid?: number, block?: string | null }
    return {
      type: 'docLink',
      attrs: { nid: nid ?? null, block: block ?? null, label: label ?? '' },
    }
  },

  renderMarkdown(node: JSONContent) {
    const { nid, block, label } = (node.attrs ?? {}) as DocLinkAttrs
    const name = docLinkLabel(label ?? '')
    // No target to preserve, so render the label as plain prose.
    if (nid === null || nid === undefined) return name
    const props = block ? `nid="${nid}" block="${block}"` : `nid="${nid}"`
    return `:${DOC_LINK_TAG}[${name}]{${props}}`
  },
})

interface DocLinkAttrs {
  nid?: number | null
  block?: string | null
  label?: string | null
}

/**
 * The label as the inline component can carry it. comark reads to the first
 * `]` and offers no escape for one, so brackets are replaced.
 */
export function docLinkLabel(label: string): string {
  return label.replace(/\[/g, '(').replace(/\]/g, ')')
}
