import { Extension, getMarkRange } from '@tiptap/core'
import { isChangeOrigin } from '@tiptap/extension-collaboration'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { pageFileForUrl } from '#shared/utils/files'
import type { PageFileChoice } from './link-target'

/**
 * Turns a link to one of this page's files into the file link node, so the
 * body never stores a download path. Covers a typed, pasted or popover URL:
 * it looks at the document after every local change.
 */
export const PageFileLinks = Extension.create<{ files: () => PageFileChoice[] }>({
  name: 'pageFileLinks',

  addOptions() {
    return { files: () => [] }
  },

  addProseMirrorPlugins() {
    const options = this.options
    return [
      new Plugin({
        key: new PluginKey('pageFileLinks'),
        appendTransaction(transactions, _old, state) {
          if (!transactions.some(tr => tr.docChanged && !isChangeOrigin(tr))) return null
          const files = options.files()
          const link = state.schema.marks.link
          const node = state.schema.nodes.attachmentInline
          if (files.length === 0 || !link || !node) return null
          const found: Array<{ from: number, to: number, file: string, href: string }> = []
          state.doc.descendants((child, pos) => {
            const mark = child.isText ? link.isInSet(child.marks) : undefined
            if (!mark || found.some(range => pos >= range.from && pos < range.to)) return
            const file = pageFileForUrl(String(mark.attrs.href ?? ''), files)
            const range = file ? getMarkRange(state.doc.resolve(pos), link, mark.attrs) : undefined
            if (file && range) found.push({ ...range, file: file.uuid, href: String(mark.attrs.href) })
          })
          if (found.length === 0) return null
          const tr = state.tr
          for (const { from, to, file, href } of found.reverse()) {
            const words = state.doc.textBetween(from, to, ' ')
            tr.replaceWith(from, to, node.create({ file, label: words === href ? '' : words }))
          }
          return tr
        },
      }),
    ]
  },
})
