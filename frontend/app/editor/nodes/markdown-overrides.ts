/**
 * @tiptap/markdown overrides pinning the engine to comark's canonical
 * forms (Vue-free; shared by the live editor, the commit schema, and the
 * corpus harness). Each override exists because the stock renderer or
 * parser diverges from the grammar the corpus enforces:
 *
 * - Underline: comark's form is inline HTML `<u>…</u>` (the stock `++…++`
 *   is not comark and must stay literal text). The stock parse path for
 *   inline HTML needs a DOM (`window.DOMParser`) — a custom tokenizer
 *   keeps the engine sync + DOM-free.
 * - Inline HTML outside the schema (`<kbd>`, `<span>`, …) strips to its
 *   text content; block-level raw HTML drops entirely. Both mirror what
 *   the editor schema can hold (accepted lossy transforms, see
 *   test/roundtrip/NORMALIZATIONS.md).
 * - HardBreak: canonical is a backslash break, not trailing spaces.
 * - CodeBlock: fence grows past the longest backtick run in the content.
 * - Link: autolinks (`<https://…>`) keep their form instead of becoming
 *   `[text](url)`.
 * - Table: compact GFM — unpadded cells, `---` separators (alignment is
 *   presentation-only and dropped), multi-block cells collapse to one
 *   line, `|` escaped.
 */
import { Extension } from '@tiptap/core'
import type { JSONContent, MarkdownRendererHelpers } from '@tiptap/core'
import CodeBlock from '@tiptap/extension-code-block'
import HardBreak from '@tiptap/extension-hard-break'
import Heading from '@tiptap/extension-heading'
import Link from '@tiptap/extension-link'
import Paragraph from '@tiptap/extension-paragraph'
import Underline from '@tiptap/extension-underline'
import { ListItem, getListMarker } from '@tiptap/extension-list'
import { Table } from '@tiptap/extension-table'
import { OkbImageInline, imageInlineMarkdown } from './image'
import type { ImageAttrs } from './image'

export const OkbUnderline = Underline.extend({
  markdownTokenizer: {
    name: 'underline',
    level: 'inline',
    start(src: string) {
      return src.indexOf('<u>')
    },
    tokenize(src, _tokens, lexer) {
      const match = src.match(/^<u>([\s\S]+?)<\/u>/)
      if (!match) return undefined
      return {
        type: 'underline',
        raw: match[0],
        text: match[1]!,
        tokens: lexer.inlineTokens(match[1]!),
      }
    },
  },
  renderMarkdown(node, helpers) {
    return `<u>${helpers.renderChildren(node)}</u>`
  },
})

/**
 * Consumes any other inline HTML tag as its own token; the parse handler
 * drops the tag, so only the surrounding text survives. The pattern
 * requires a bare tag name followed by whitespace-led attributes or the
 * closing bracket — an autolink like `<https://…>` has `:` right after
 * the name and falls through to marked's own rules.
 */
const InlineHtmlStrip = Extension.create({
  name: 'inlineHtmlStrip',
  markdownTokenName: 'inlineHtmlTag',
  markdownTokenizer: {
    name: 'inlineHtmlTag',
    level: 'inline',
    start(src: string) {
      return src.indexOf('<')
    },
    tokenize(src) {
      const match = src.match(/^<\/?([a-zA-Z][\w-]*)(\s+[^<>]*?)?\s*\/?>/)
      // `<u>` belongs to the underline tokenizer.
      if (!match || match[1] === 'u') return undefined
      return { type: 'inlineHtmlTag', raw: match[0] }
    },
  },
  parseMarkdown: () => [],
})

/**
 * Block-level raw HTML: the editor schema cannot hold it — dropped as
 * accepted-lossy (NORMALIZATIONS.md L2), invisible to S3. The
 * tokenizer claims the block (a `<tag …>` line through the next blank
 * line) before marked's own html rule; the token type has no handler and
 * no child tokens, so the parser drops it.
 */
const BlockHtmlDrop = Extension.create({
  name: 'blockHtmlDrop',
  markdownTokenizer: {
    name: 'blockHtmlDrop',
    level: 'block',
    start(src: string) {
      const index = src.match(/^<\/?[a-zA-Z][\w-]*(?:[\s>/]|$)/m)?.index
      return index !== undefined ? index : -1
    },
    tokenize(src) {
      const match = src.match(/^<\/?[a-zA-Z][\w-]*(?:[\s>/]|$)[^\n]*(?:\n(?!\s*\n)[^\n]*)*\n?/)
      if (!match) return undefined
      return { type: 'blockHtmlDrop', raw: match[0] }
    },
  },
})

export const OkbHardBreak = HardBreak.extend({
  renderMarkdown: () => '\\\n',
})

export const OkbCodeBlock = CodeBlock.extend({
  renderMarkdown(node) {
    const language = (node.attrs as { language?: string } | undefined)?.language ?? ''
    const text = (node.content ?? []).map(child => child.text ?? '').join('')
    // A fence must be longer than any backtick run inside the content.
    const backticks = text.match(/`{3,}/gm)
    const fence = backticks ? backticks.sort().slice(-1)[0] + '`' : '```'
    return `${fence}${language}\n${text}\n${fence}`
  },
})

/**
 * Rewrites `[url](url)` back to the `<url>` autolink form outside inline
 * code spans. The mark renderer cannot do this itself — the manager
 * derives mark delimiters from a synthetic placeholder render, so the
 * real link text is never visible to it.
 */
function restoreAutolinks(rendered: string): string {
  return rendered
    .split(/(`+[\s\S]*?`+)/)
    .map((segment, i) => i % 2 === 1
      ? segment
      : segment.replace(/\[([a-z][a-z0-9+.-]*:[^\]\s]*)\]\(\1\)/gi, '<$1>'))
    .join('')
}

const EMPTY_PARAGRAPH_MARKDOWN = '&nbsp;'

export const OkbParagraph = Paragraph.extend({
  renderMarkdown(node, helpers, ctx) {
    const content = node.content ?? []
    if (content.length === 0) {
      const previous = ctx?.previousNode
      const previousIsEmptyParagraph = previous?.type === 'paragraph' && (previous.content ?? []).length === 0
      return previousIsEmptyParagraph ? EMPTY_PARAGRAPH_MARKDOWN : ''
    }
    return restoreAutolinks(helpers.renderChildren(content))
  },
})

export const OkbHeading = Heading.extend({
  renderMarkdown(node, helpers) {
    const level = Number((node.attrs as { level?: number } | undefined)?.level ?? 1)
    if (!node.content) return ''
    return `${'#'.repeat(level)} ${restoreAutolinks(helpers.renderChildren(node.content))}`
  },
})

/**
 * The stock list-item renderer (renderNestedMarkdownContent) separates a
 * following non-paragraph block with a single newline — right for nested
 * lists, wrong for a component fence, which needs the blank line comark's
 * block parser requires. Same logic otherwise.
 */
export const OkbListItem = ListItem.extend({
  renderMarkdown(node, helpers, ctx) {
    const [first, ...rest] = node.content ?? []
    let prefix = '- '
    if (ctx?.parentType === 'orderedList') {
      const attrs = (ctx.meta as { parentAttrs?: { start?: number, type?: string } } | undefined)?.parentAttrs
      const start = Number(attrs?.start ?? 1)
      const index = start - 1 + (ctx.index ?? 0)
      prefix = getListMarker(attrs?.type, index, '. ')
    }
    let output = `${prefix}${helpers.renderChildren(first ? [first] : [])}`
    rest.forEach((child, index) => {
      const childContent = helpers.renderChild?.(child, index + 1) ?? helpers.renderChildren([child])
      if (childContent === undefined || childContent === null) return
      const indented = childContent.split('\n')
        .map(line => (line ? helpers.indent(line) : line)).join('\n')
      const blankSeparated = child.type === 'paragraph'
        || child.type === 'callout' || child.type === 'infobox'
      output += (blankSeparated ? '\n\n' : '\n') + indented
    })
    return output
  },
})

export const OkbLink = Link.extend({
  renderMarkdown(node, helpers) {
    const { href = '', title } = (node.attrs ?? {}) as { href?: string, title?: string | null }
    const text = helpers.renderChildren(node)
    if (!title && text === href) return `<${href}>`
    return title ? `[${text}](${href} "${title}")` : `[${text}](${href})`
  },
})

/**
 * One table cell as a single line: block children collapse to one line
 * joined with a space (GFM cells cannot hold blocks), `|` escaped.
 */
function tableCellLine(cell: JSONContent, helpers: MarkdownRendererHelpers): string {
  // Image blocks in a cell (the paragraph-split normalization leaves them
  // as direct cell children) keep their inline markdown form — the block
  // fence can't live on a one-line cell.
  const parts = (cell.content ?? []).map(block =>
    block.type === 'image'
      ? imageInlineMarkdown((block.attrs ?? {}) as ImageAttrs)
      : helpers.renderChildren(block.content ?? []))
  return parts.join(' ').replace(/\n/g, ' ').replace(/\|/g, '\\|').trim()
}

export const OkbTable = Table.extend({
  renderMarkdown(node, helpers) {
    const rows: string[][] = (node.content ?? []).map(row =>
      (row.content ?? []).map(cell => tableCellLine(cell, helpers)))
    const width = Math.max(...rows.map(r => r.length), 1)
    const line = (cells: string[]) =>
      '| ' + Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ') + ' |'
    return [
      line(rows[0] ?? []),
      '| ' + Array.from({ length: width }, () => '---').join(' | ') + ' |',
      ...rows.slice(1).map(line),
    ].join('\n')
  },
})

/** The markdown-only override extensions (no schema contribution). */
export function markdownOverrideExtensions() {
  return [InlineHtmlStrip, BlockHtmlDrop, OkbImageInline]
}
