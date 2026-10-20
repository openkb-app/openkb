import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import type { Node as ProseNode } from '@tiptap/pm/model'
import { docLinkHref } from '#shared/utils/doc-links'
import { CITATION_TAG } from '#shared/utils/citations'

const LINK_SELECTOR = 'a[href], [data-type="doc-link"][data-nid], [data-type="citation"]'

function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)
}

export function linkOpenHint(): string {
  return `${isMac() ? 'Cmd' : 'Ctrl'}+Click to open`
}

/** A click that opens a link instead of editing it. On macOS Ctrl+Click is the context menu. */
function opensLink(event: MouseEvent): boolean {
  return event.button === 1 || (event.button === 0 && (isMac() ? event.metaKey : event.ctrlKey))
}

/**
 * Opens a page link at its target's alias.
 *
 * The tab opens before the alias is known, so the browser still counts the
 * click as the user's and does not block it.
 */
async function openPageLink(nid: number, block: string | null): Promise<void> {
  const tab = window.open('', '_blank')
  if (!tab) return
  tab.opener = null
  const found = await fetch(`/api/node/${nid}?version=default`)
    .then(response => (response.ok ? response.json() as Promise<{ path?: string }> : null))
    .catch(() => null)
  tab.location.replace(docLinkHref(nid, found?.path ?? null, block))
}

/** Opens one link element of the editor in a new tab. */
function openLink(element: Element): void {
  const url = element instanceof HTMLAnchorElement ? element.href : element.getAttribute('data-url')
  if (url) {
    window.open(url, '_blank', 'noopener,noreferrer')
    return
  }
  const nid = Number(element.getAttribute('data-nid'))
  if (Number.isInteger(nid) && nid > 0) void openPageLink(nid, element.getAttribute('data-block') || null)
}

/** The link under the click, skipping empty and fragment-only hrefs: those would open the editor page again. */
function linkAt(root: HTMLElement, event: MouseEvent): Element | null {
  const target = event.target
  if (!(target instanceof Element)) return null
  const link = target.closest(LINK_SELECTOR)
  if (!link || !root.contains(link)) return null
  const href = link.getAttribute('href')
  return href === null || (href !== '' && !href.startsWith('#')) ? link : null
}

function decorate(doc: ProseNode): DecorationSet {
  const title = linkOpenHint()
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'docLink' || node.type.name === CITATION_TAG || node.type.name === 'attachmentInline') {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, { title }))
    }
    else if (node.isText && node.marks.some(mark => mark.type.name === 'link')) {
      decorations.push(Decoration.inline(pos, pos + node.nodeSize, { title }))
    }
  })
  return DecorationSet.create(doc, decorations)
}

/**
 * Opens a link in a new tab on Ctrl+Click (Cmd+Click on macOS) or a
 * middle-click; a plain click keeps editing. Covers link marks, page links,
 * citations and file links.
 * Every link gets a hover hint as a decoration, so it never reaches the markdown.
 */
export const LinkOpen = Extension.create({
  name: 'linkOpen',

  addProseMirrorPlugins() {
    const key = new PluginKey<DecorationSet>('linkOpen')
    // Cancels mousedown, mouseup and click alike: Firefox adds a selection range
    // on Ctrl+Click, and a middle-click pastes on Linux.
    const cancel = (view: EditorView, event: MouseEvent): Element | null => {
      if (!opensLink(event)) return null
      const link = linkAt(view.dom, event)
      if (link) event.preventDefault()
      return link
    }
    const open = (view: EditorView, event: MouseEvent): boolean => {
      const link = cancel(view, event)
      if (link) openLink(link)
      return link !== null
    }

    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_config, state) => decorate(state.doc),
          apply: (tr, value) => (tr.docChanged ? decorate(tr.doc) : value),
        },
        props: {
          decorations(state) {
            return key.getState(state)
          },
          handleDOMEvents: {
            mousedown: (view, event) => cancel(view, event) !== null,
            mouseup: (view, event) => cancel(view, event) !== null,
            click: open,
            auxclick: open,
          },
        },
      }),
    ]
  },
})
