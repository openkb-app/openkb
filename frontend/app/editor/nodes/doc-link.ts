import { Node, mergeAttributes } from '@tiptap/core'

/**
 * A link to another page: schema only (no Vue), so the server-side commit
 * schema can reuse it.
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
})

interface DocLinkAttrs {
  nid?: number | null
  block?: string | null
  label?: string | null
}
