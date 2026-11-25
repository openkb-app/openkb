/**
 * comark AST ⇄ ProseMirror JSON for the editor schema
 * (server/utils/editor-schema.ts).
 *
 * comark parses and renders the markdown; this module only maps node shapes.
 * Every block keeps the id comark reads on it; only top-level blocks are
 * review units, so only theirs are written back.
 */
import type { JSONContent } from '@tiptap/core'
import { DROPPED_TAGS } from '#shared/utils/comark-tree'
import type { ComarkNode, ComarkProps } from '#shared/utils/comark-tree'
import { CITATION_TAG, citeTarget } from '#shared/utils/citations'
import { DOC_LINK_TAG, docLinkTarget } from '#shared/utils/doc-links'
import { parseImageWidth } from '#shared/utils/image-width'
import { WRAPPED_BLOCK_TYPES } from '#shared/page-blocks'
import { comarkComponentDeclarations, listBlockComponentDeclarations, listChipComponentDeclarations, readNodeAttributesFromProps, writePropsFromNodeAttributes } from '#shared/utils/comark-components'
import { chipFormOf } from '../editor/nodes/component-node'
import type { ComarkComponentDeclaration } from '#shared/utils/comark-components'

export type ComarkElement = [tag: string, props: ComarkProps, ...children: ComarkNode[]]

interface Mark {
  type: string
  attrs?: Record<string, unknown>
}

/** A wrapper fence carrying the id of a block comark has no attribute syntax for. */
export const BLOCK_WRAPPER_TAG = 'block'

const NBSP = '\u00A0'

/**
 * Marks an empty paragraph written `&nbsp;`. comark 0.8.1's writers `trim()` a
 * raw no-break space where they trim: a box's or list item's end, both ends of
 * a quote, and every empty paragraph in a list item.
 */
export const NBSP_ENTITY_TAG = 'okb-nbsp-entity'

/** Marks a file component written inline (`:image{…}`), not as a fence. */
const INLINE = { $: { block: 0 } }

const MARK_TAGS: Record<string, string> = {
  strong: 'bold',
  em: 'italic',
  del: 'strike',
  u: 'underline',
  code: 'code',
  a: 'link',
}

/** Components that are blocks unless they stand in running text. */
const FILE_COMPONENTS = new Set(['image', 'attachment'])

/** Tags that are blocks wherever they appear: the block components among them. */
const BLOCK_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'blockquote', 'pre', 'hr', 'table', BLOCK_WRAPPER_TAG,
  ...listBlockComponentDeclarations().map(declaration => declaration.tag).filter(tag => !FILE_COMPONENTS.has(tag)),
])

/** Raw HTML that reads as running text even on lines of its own. */
const PHRASING_HTML = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'i', 'ins', 'kbd',
  'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var',
])

// ---------------------------------------------------------------------------
// comark → ProseMirror
// ---------------------------------------------------------------------------

/** Maps comark's tree to the editor's ProseMirror document JSON. */
export function comarkToPm(nodes: ComarkNode[]): JSONContent {
  return { type: 'doc', content: mapComarkBlocks(nodes.map(unescapeComponentProps)) }
}

/** Components whose props are MDC attributes. */
const COMPONENT_TAGS = new Set([...Object.keys(comarkComponentDeclarations), BLOCK_WRAPPER_TAG])

/** The declaration of a block component mapped by its props alone; image and attachment have forms of their own. */
function genericBlockDeclarationOf(tag: string | undefined): ComarkComponentDeclaration | undefined {
  const declaration = tag ? comarkComponentDeclarations[tag] : undefined
  return declaration && !declaration.inline && !FILE_COMPONENTS.has(declaration.tag) ? declaration : undefined
}

/** Drops the backslash comark keeps before a quote in a component's prop values. */
function unescapeComponentProps(node: ComarkNode): ComarkNode {
  if (typeof node === 'string') return node
  const [tag, props, ...children] = node
  const unescaped = COMPONENT_TAGS.has(tag)
    ? Object.fromEntries(Object.entries(props).map(([key, value]) =>
        [key, typeof value === 'string' ? value.replace(/\\(["'])/g, '$1') : value]))
    : props
  return [tag, unescaped, ...children.map(unescapeComponentProps)] as ComarkNode
}

/** Maps comark nodes to blocks, running inline nodes into paragraphs. */
function mapComarkBlocks(nodes: ComarkNode[]): JSONContent[] {
  const inText = nodes.some(node => typeof node === 'string')
  const blocks: JSONContent[] = []
  let run: ComarkNode[] = []
  /** Closes the current run of inline nodes into a paragraph. */
  const flushInlineRun = () => {
    if (run.length > 0) blocks.push(...mapParagraph({}, run))
    run = []
  }
  for (const node of nodes) {
    if (isInlineInComark(node, inText) && (inText || !isRawHtml(node))) {
      run.push(node)
      continue
    }
    flushInlineRun()
    // A tag on lines of its own between blocks is a paragraph of its own.
    if (isInlineInComark(node, inText)) {
      blocks.push(...mapParagraph({}, [node]))
      continue
    }
    blocks.push(...mapComarkBlock(node as ComarkElement))
  }
  flushInlineRun()
  return blocks
}

/** Whether a comark node is inline among its siblings. */
function isInlineInComark(node: ComarkNode, inText: boolean): boolean {
  if (typeof node === 'string') return true
  const [tag, props] = node
  // A comment in running text is dropped from it; one between blocks is no block.
  if (tag === null) return inText
  if (BLOCK_TAGS.has(tag)) return false
  // A labelled attachment is the inline one: the block form carries no content.
  if (FILE_COMPONENTS.has(tag)) return inText || (tag === 'attachment' && node.length > 2)
  return !isRawHtmlBlock(props) || (inText && PHRASING_HTML.has(tag))
}

/** Whether a comark node is raw HTML. */
export function isRawHtml(node: ComarkNode): boolean {
  return Array.isArray(node) && (node[1].$ as { html?: number } | undefined)?.html === 1
}

/** Whether comark read the node as a raw HTML block. */
function isRawHtmlBlock(props: ComarkProps): boolean {
  return (props?.$ as { block?: number } | undefined)?.block === 1
}

/** The block id attribute comark read on a node, if any. */
function blockIdAttrs(props: ComarkProps): { id?: string } {
  return typeof props.id === 'string' && props.id !== '' ? { id: props.id } : {}
}

/** Maps one comark block element to editor blocks. */
function mapComarkBlock([tag, props, ...children]: ComarkElement): JSONContent[] {
  // Comments, scripts and the like show nothing on the read page.
  if (tag === null || DROPPED_TAGS.has(tag)) return []
  if (isRawHtmlBlock(props)) {
    if (!PHRASING_HTML.has(tag)) return []
    // An unclosed tag wraps the blocks after it: they stay blocks.
    return children.some(child => Array.isArray(child) && BLOCK_TAGS.has(child[0]))
      ? mapComarkBlocks(children)
      : mapParagraph({}, [[tag, {}, ...children]])
  }
  const id = blockIdAttrs(props)
  switch (tag) {
    case 'p':
      return mapParagraph(props, children)
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
      return [withContentIfAny({ type: 'heading', attrs: { level: Number(tag[1]), ...id } }, mapInlineNodes(children).map(joinHeadingLines))]
    case 'ul':
      return String(props.class ?? '').includes('contains-task-list')
        ? [{ type: 'taskList', attrs: id, content: children.map(mapTaskItem) }]
        : [{ type: 'bulletList', attrs: id, content: children.map(mapListItem) }]
    case 'ol': {
      const start = Number(props.start ?? 1)
      return [{ type: 'orderedList', attrs: { ...(start !== 1 ? { start } : {}), ...id }, content: children.map(mapListItem) }]
    }
    case 'blockquote':
      return [{ type: 'blockquote', attrs: id, content: withAtLeastOneParagraph(mapComarkBlocks(children)) }]
    case 'pre': {
      const text = textContentOf(children)
      return [withContentIfAny({ type: 'codeBlock', attrs: { language: props.language ?? null, meta: fenceMeta(props), ...id } }, text ? [{ type: 'text', text }] : [])]
    }
    case 'hr':
      return [{ type: 'horizontalRule', attrs: id }]
    case 'table':
      return [{ type: 'table', attrs: id, content: mapTableRows(children) }]
    case 'image':
      return mapImageNodes(props, id)
    case 'attachment':
      return [{ type: 'attachment', attrs: { file: stringPropOrUndefined(props.file) ?? null, description: stringPropOrUndefined(props.description) || null, ...id } }]
    default: {
      const declaration = genericBlockDeclarationOf(tag)
      if (declaration) {
        const node: JSONContent = { type: tag, attrs: { ...readNodeAttributesFromProps(declaration, props), ...id } }
        return [declaration.slot ? { ...node, content: withAtLeastOneParagraph(mapComarkBlocks(children)) } : node]
      }
      // A `::block` wrapper, whose id comark has already moved onto its
      // content, or an unknown fence, whose content is kept.
      return mapComarkBlocks(children)
    }
  }
}

/** Joins a code fence's info string after the language back from the parts comark splits it into. */
function fenceMeta(props: ComarkProps): string | null {
  const { filename, highlights, meta } = props as { filename?: string, highlights?: number[], meta?: string }
  const parts = [
    filename ? `[${filename}]` : '',
    highlights?.length ? `{${highlights.join(',')}}` : '',
    meta ?? '',
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : null
}

/** Maps a comark paragraph; one left with neither words nor id (raw HTML dropped from it) is none. */
function mapParagraph(props: ComarkProps, children: ComarkNode[]): JSONContent[] {
  const id = blockIdAttrs(props)
  // A no-break space alone is how comark writes an empty paragraph.
  if (children.length === 1 && children[0] === NBSP) return [{ type: 'paragraph', attrs: id }]
  // A plain image with its id trailing the line.
  if (children.length === 1 && Array.isArray(children[0]) && children[0][0] === 'img') {
    return mapImageNodes(children[0][1], id.id ? id : blockIdAttrs(children[0][1]))
  }
  const content = mapInlineNodes(children)
  return content.length > 0 || id.id ? [withContentIfAny({ type: 'paragraph', attrs: id }, content)] : []
}

/** Maps an image's props to an image node; one naming neither a file nor a source is none. */
function mapImageNodes(props: ComarkProps, id: { id?: string }): JSONContent[] {
  const file = stringPropOrUndefined(props.file)
  if (file) {
    return [{
      type: 'image',
      attrs: { file, alt: stringPropOrUndefined(props.alt) ?? '', src: null, title: null, width: parseImageWidth(props.width), ...id },
    }]
  }
  if (!props.src) return []
  return [{
    type: 'image',
    attrs: { src: String(props.src), alt: unescapeAltText(String(props.alt ?? '')), title: (props.title as string | undefined) ?? null, file: null, ...id },
  }]
}

/** Maps a comark list item to a list item node. */
function mapListItem(node: ComarkNode): JSONContent {
  const children = Array.isArray(node) ? node.slice(2) as ComarkNode[] : [node]
  return { type: 'listItem', content: withLeadingParagraph(mapComarkBlocks(children)) }
}

/** Maps a comark task list item to a task item node, its checkbox read off as `checked`. */
function mapTaskItem(node: ComarkNode): JSONContent {
  let children = Array.isArray(node) ? node.slice(2) as ComarkNode[] : [node]
  let checked = false
  /** Takes the checkbox off the front of the nodes, reading its state; it leads the item, or its first paragraph in a loose item. */
  const takeLeadingCheckbox = (nodes: ComarkNode[]): ComarkNode[] => {
    const [first, ...rest] = nodes
    if (!Array.isArray(first) || first[0] !== 'input') return nodes
    checked = !!(first[1].checked || first[1][':checked'])
    return typeof rest[0] === 'string' ? [rest[0].replace(/^ /, ''), ...rest.slice(1)].filter(c => c !== '') : rest
  }
  const [first, ...rest] = children
  children = Array.isArray(first) && first[0] === 'p'
    ? [[first[0], first[1], ...takeLeadingCheckbox(first.slice(2) as ComarkNode[])], ...rest]
    : takeLeadingCheckbox(children)
  return { type: 'taskItem', attrs: { checked }, content: withLeadingParagraph(mapComarkBlocks(children)) }
}

/** Prepends an empty paragraph where the blocks do not start with one: list items do. */
function withLeadingParagraph(blocks: JSONContent[]): JSONContent[] {
  return blocks[0]?.type === 'paragraph' ? blocks : [{ type: 'paragraph' }, ...blocks]
}

/** Returns the blocks, or one empty paragraph where there are none: a container holds a block. */
function withAtLeastOneParagraph(blocks: JSONContent[]): JSONContent[] {
  return blocks.length > 0 ? blocks : [{ type: 'paragraph' }]
}

/** Maps comark's table sections and rows to table row nodes. */
function mapTableRows(children: ComarkNode[]): JSONContent[] {
  const rows: JSONContent[] = []
  for (const section of children) {
    if (!Array.isArray(section)) continue
    const trs = section[0] === 'tr' ? [section] : section.slice(2)
    for (const tr of trs) {
      if (!Array.isArray(tr)) continue
      rows.push({
        type: 'tableRow',
        content: (tr.slice(2) as ComarkNode[]).filter(Array.isArray).map(cell => ({
          type: cell[0] === 'th' ? 'tableHeader' : 'tableCell',
          content: withAtLeastOneParagraph(mapComarkBlocks(cell.slice(2) as ComarkNode[])),
        })),
      })
    }
  }
  return rows
}

/** Maps comark inline nodes; a `<br>` tag alone on its line takes that line's break with it. */
function mapInlineNodes(nodes: ComarkNode[], marks: Mark[] = []): JSONContent[] {
  return nodes.flatMap((node, at) => {
    const previous = nodes[at - 1]
    const lineBreakTag = Array.isArray(node) && node[0] === 'br' && (node[1].$ as { html?: number } | undefined)?.html === 1
    return lineBreakTag && typeof previous === 'string' && previous.endsWith('\n') ? [] : mapInlineNode(node, marks)
  })
}

/** Maps one comark inline node to editor inline nodes, carrying the marks around it. */
function mapInlineNode(node: ComarkNode, marks: Mark[]): JSONContent[] {
  if (typeof node === 'string') {
    return node === '' ? [] : [{ type: 'text', text: node, ...(marks.length > 0 ? { marks } : {}) }]
  }
  const [tag, props, ...children] = node
  if (tag === null || DROPPED_TAGS.has(tag)) return []
  const markType = MARK_TAGS[tag]
  if (markType) {
    const attrs = tag === 'a' ? { href: props.href ?? '', title: props.title ?? null } : undefined
    const mark: Mark = attrs ? { type: markType, attrs } : { type: markType }
    return mapInlineNodes(children, marks.some(m => m.type === markType) ? marks : [...marks, mark])
  }
  switch (tag) {
    case 'br':
      return [{ type: 'hardBreak', ...(marks.length > 0 ? { marks } : {}) }]
    case 'img':
    case 'image':
      return mapImageNodes(props, blockIdAttrs(props))
    case 'input':
      return []
    case 'mention': {
      const uid = stringPropOrUndefined(props.uid)
      return uid && /^\d+$/.test(uid)
        ? [{ type: 'mention', attrs: { id: Number(uid), label: textContentOf(children) } }]
        : mapInlineNodes(children, marks)
    }
    case DOC_LINK_TAG: {
      const target = docLinkTarget(props)
      return target
        ? [{ type: 'docLink', attrs: { nid: target.nid, block: target.block, label: textContentOf(children) } }]
        : mapInlineNodes(children, marks)
    }
    case CITATION_TAG: {
      const target = citeTarget(props)
      if (!target) return []
      return [{
        type: CITATION_TAG,
        attrs: target.kind === 'url'
          ? { url: target.url }
          : { nid: target.nid, block: target.block, v: target.v },
      }]
    }
    case 'attachment': {
      const file = stringPropOrUndefined(props.file)
      return file ? [{ type: 'attachmentInline', attrs: { file, label: textContentOf(children) } }] : []
    }
    case 'span':
      // comark reads `[1]` in prose as a span with no attributes: the brackets are the writer's words.
      if (Object.keys(props).length === 0) return mapInlineNodes(['[', ...children, ']'], marks)
      return mapInlineNodes(children, marks)
    default: {
      const chip = comarkComponentDeclarations[tag]
      if (chip?.inline) {
        const attrs = { ...readNodeAttributesFromProps(chip, props), ...(chip.slot ? { label: textContentOf(children) } : {}) }
        return [{ type: chipFormOf(tag).node, attrs }]
      }
      // Inline HTML and unknown components: their words stay, the tag goes.
      return mapInlineNodes(children, marks)
    }
  }
}

/** Reads a setext heading's line break as a space: comark writes a heading on one line. */
function joinHeadingLines(node: JSONContent): JSONContent {
  return node.type === 'text' && node.text?.includes('\n')
    ? { ...node, text: node.text.replace(/[ \t]*\n[ \t]*/g, ' ') }
    : node
}

/** Returns the node with `content` set, unless the content is empty. */
function withContentIfAny(node: JSONContent, content: JSONContent[]): JSONContent {
  return content.length > 0 ? { ...node, content } : node
}

/** The text of comark nodes, at any depth. */
export function textContentOf(nodes: ComarkNode[]): string {
  return nodes.map(node => typeof node === 'string' ? node : textContentOf(node.slice(2) as ComarkNode[])).join('')
}

/** Drops the backslash escapes comark keeps in an image's alt text. */
function unescapeAltText(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, '$1')
}

/** A prop's value when it is a string. */
function stringPropOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

// ---------------------------------------------------------------------------
// ProseMirror → comark
// ---------------------------------------------------------------------------

/**
 * Maps the editor's document to comark's tree; the empty paragraphs it opens
 * on are not written, as the stored gap under the title is one blank line.
 */
export function pmToComark(doc: JSONContent): ComarkElement[] {
  const nodes = doc.content ?? []
  const first = nodes.findIndex(node => !isEmptyParagraph(node))
  return writeEmptyParagraphsBetween(first < 0 ? [] : nodes.slice(first), mapTopLevelBlock)
}

/**
 * Maps blocks to comark, each empty paragraph between two of them as a
 * no-break space; the empty paragraphs they end on are not written.
 */
function writeEmptyParagraphsBetween(nodes: JSONContent[], map: (node: JSONContent) => ComarkElement): ComarkElement[] {
  return nodes.slice(0, endOfLastFilledBlock(nodes)).map(node => isEmptyParagraph(node) ? ['p', {}, NBSP] : map(node))
}

/**
 * Where a container's writer trims a raw no-break space, so its empty
 * paragraphs there are written `&nbsp;`.
 * - `end`: after its last filled block.
 * - `both-ends`: before its first and after its last filled block.
 * - `everywhere`: every empty paragraph.
 */
type TrimmedEdges = 'end' | 'both-ends' | 'everywhere'

/**
 * Maps a container's blocks to comark, each empty paragraph as a no-break
 * space, or as `&nbsp;` where the container's writer trims. A container
 * holding no other block writes none.
 */
function writeContainerBlocksWithEmptyParagraphs(nodes: JSONContent[], map: (node: JSONContent) => ComarkElement, trimmed: TrimmedEdges): ComarkElement[] {
  const end = endOfLastFilledBlock(nodes)
  if (end === 0) return []
  const start = trimmed === 'both-ends' ? nodes.findIndex(node => !isEmptyParagraph(node)) : 0
  return nodes.map((node, index): ComarkElement => {
    if (!isEmptyParagraph(node)) return map(node)
    const asEntity = trimmed === 'everywhere' || index < start || index >= end
    return ['p', {}, asEntity ? [NBSP_ENTITY_TAG, {}] : NBSP]
  })
}

/** The index after the last block that is not an empty paragraph. */
function endOfLastFilledBlock(nodes: JSONContent[]): number {
  let end = nodes.length
  while (end > 0 && isEmptyParagraph(nodes[end - 1]!)) end--
  return end
}

/** Whether a node is a paragraph holding nothing. */
function isEmptyParagraph(node: JSONContent): boolean {
  return node.type === 'paragraph' && !node.content?.length
}

/** Maps a top-level block to comark, its block id on it or on a `::block` wrapper. */
function mapTopLevelBlock(node: JSONContent): ComarkElement {
  // An empty text block holds nothing a reader sees; its id alone would not read back.
  const id = isEmptyParagraph(node) || (node.type === 'heading' && !node.content?.length) ? null : blockIdOf(node)
  if (id && WRAPPED_BLOCK_TYPES.has(node.type ?? '')) {
    return [BLOCK_WRAPPER_TAG, { id }, mapPmBlock(node)]
  }
  const element = mapPmBlock(node)
  if (id) element[1] = { ...element[1], id }
  return element
}

/** A node's block id, or null when it has none. */
function blockIdOf(node: JSONContent): string | null {
  const id = (node.attrs as { id?: unknown } | undefined)?.id
  return typeof id === 'string' && id !== '' ? id : null
}

/** Maps a box's blocks to comark. */
function mapPmBlocks(nodes: JSONContent[] | undefined): ComarkElement[] {
  return writeContainerBlocksWithEmptyParagraphs(nodes ?? [], mapPmBlock, 'end')
}

/** Maps one editor block to a comark element. */
function mapPmBlock(node: JSONContent): ComarkElement {
  const attrs = (node.attrs ?? {}) as Record<string, unknown>
  switch (node.type) {
    case 'paragraph':
      return ['p', {}, ...mapPmInlineContent(node.content)]
    case 'heading':
      return [`h${Number(attrs.level ?? 1)}`, {}, ...mapPmInlineContent(node.content)]
    case 'bulletList':
      return ['ul', {}, ...(node.content ?? []).map(item => mapListItemElement(item, {}))]
    case 'orderedList': {
      const start = Number(attrs.start ?? 1)
      return ['ol', start !== 1 ? { start } : {}, ...(node.content ?? []).map(item => mapListItemElement(item, {}))]
    }
    case 'taskList':
      return ['ul', { class: 'contains-task-list' }, ...(node.content ?? []).map(item => {
        const element = mapListItemElement(item, { class: 'task-list-item' })
        element.splice(2, 0, ['input', { class: 'task-list-item-checkbox', type: 'checkbox', ...(item.attrs?.checked ? { ':checked': 'true' } : {}) }])
        return element
      })]
    case 'blockquote':
      return ['blockquote', {}, ...writeContainerBlocksWithEmptyParagraphs(node.content ?? [], mapPmBlock, 'both-ends')]
    case 'codeBlock':
      return ['pre', dropUnsetProps({ language: attrs.language, meta: attrs.language ? attrs.meta : null }), ['code', {}, (node.content ?? []).map(t => t.text ?? '').join('')]]
    case 'horizontalRule':
      return ['hr', {}]
    case 'table':
      return ['table', {}, ...(node.content ?? []).map(row => ['tr', {}, ...(row.content ?? []).map(cell =>
        [cell.type === 'tableHeader' ? 'th' : 'td', {}, ...mapCellToOneLine(cell)] as ComarkElement)] as ComarkElement)]
    case 'image':
      return attrs.file ? ['image', fileImageComponentProps(attrs)] : ['p', {}, plainImageElement(attrs)]
    case 'attachment':
      return ['attachment', dropUnsetProps({ file: attrs.file, description: attrs.description })]
    default: {
      const declaration = genericBlockDeclarationOf(node.type)
      if (declaration) {
        const props = writePropsFromNodeAttributes(declaration, attrs)
        return declaration.slot ? [declaration.tag, props, ...mapPmBlocks(node.content)] : [declaration.tag, props]
      }
      return ['p', {}, ...mapPmInlineContent(node.content)]
    }
  }
}

/**
 * Maps a list item to an `li`; an empty lead paragraph before another block
 * is the schema's and not written. Every other empty paragraph is `&nbsp;`:
 * comark's list item writer trims a raw no-break space.
 */
function mapListItemElement(item: JSONContent, props: ComarkProps): ComarkElement {
  const [lead, next, ...rest] = item.content ?? []
  const schemaLead = lead && next && isEmptyParagraph(lead) && next.type !== 'paragraph'
  return ['li', props, ...writeContainerBlocksWithEmptyParagraphs(schemaLead ? [next, ...rest] : item.content ?? [], mapPmBlock, 'everywhere')]
}

/** Maps a table cell to one line: the text of its blocks at any depth joined by a space, code as inline code. */
function mapCellToOneLine(cell: JSONContent): ComarkNode[] {
  return collectCellTextblocks(cell.content ?? []).flatMap((block, index) => {
    const content = block.type === 'image'
      ? [block.attrs?.file ? ['image', { ...fileImageComponentProps(block.attrs), ...INLINE }] as ComarkElement : plainImageElement(block.attrs ?? {})]
      : block.type === 'codeBlock'
        ? [['code', {}, (block.content ?? []).map(text => text.text ?? '').join('').replace(/\n/g, ' ')] as ComarkElement]
        : mapPmInlineContent(block.content)
    return index > 0 ? [' ', ...content] : content
  })
}

/** Collects the textblocks and images a cell's blocks hold, at any depth. */
function collectCellTextblocks(blocks: JSONContent[]): JSONContent[] {
  return blocks.flatMap(block => block.type === 'image' || block.type === 'codeBlock' || block.type === 'paragraph' || block.type === 'heading'
    ? [block]
    : collectCellTextblocks(block.content ?? []))
}

/** The props of an `::image` component for a file image. */
function fileImageComponentProps(attrs: Record<string, unknown>): ComarkProps {
  return dropUnsetProps({ file: attrs.file, alt: attrs.alt || null, width: attrs.width ? `${attrs.width}%` : null })
}

/** The comark `img` element for an image with a source. */
function plainImageElement(attrs: Record<string, unknown>): ComarkElement {
  return ['img', dropUnsetProps({ src: attrs.src ?? '', alt: attrs.alt ?? '', title: attrs.title })]
}

/** Drops props that are null, undefined or empty; an empty `src` or `alt` stays. */
function dropUnsetProps(props: Record<string, unknown>): ComarkProps {
  return Object.fromEntries(Object.entries(props).filter(([key, value]) =>
    value !== null && value !== undefined && (value !== '' || key === 'src' || key === 'alt')))
}

/** Maps inline content to comark, nesting text into mark elements kept open across the runs they span. */
function mapPmInlineContent(content: JSONContent[] | undefined): ComarkNode[] {
  const root: ComarkElement = ['', {}]
  const open: Array<{ mark: Mark, element: ComarkElement }> = []
  /** The innermost open mark element, or the root. */
  const innermostOpenElement = () => open.at(-1)?.element ?? root
  for (const node of content ?? []) {
    const marks = sortMarksForNesting(node.marks ?? [])
    let keep = 0
    while (keep < open.length && marks.some(m => isSameMark(m, open[keep]!.mark))) keep++
    open.length = keep
    for (const mark of marks) {
      if (open.some(o => isSameMark(o.mark, mark))) continue
      const element = markToComarkElement(mark)
      innermostOpenElement().push(element)
      open.push({ mark, element })
    }
    innermostOpenElement().push(...mapPmInlineNode(node))
  }
  return root.slice(2) as ComarkNode[]
}

/**
 * Nesting ranks; a lower rank opens first, unlisted marks rank 0.
 * - underline: comark reads `<u>**a**</u>` as both marks, `**<u>a</u>**` not.
 * - link: outside other marks, `[**a**](url)`; block versions hash this spelling.
 * - code: a leaf.
 */
const MARK_NESTING_RANKS: Record<string, number> = {
  underline: -2,
  link: -1,
  code: 1,
}

/** A mark's nesting rank. */
function markNestingOrder(mark: Mark): number {
  return MARK_NESTING_RANKS[mark.type] ?? 0
}

/** Sorts marks into the order they nest in. */
function sortMarksForNesting(marks: Mark[]): Mark[] {
  return [...marks].sort((a, b) => markNestingOrder(a) - markNestingOrder(b))
}

/** Whether two marks are the same type with the same attributes. */
function isSameMark(a: Mark, b: Mark): boolean {
  return a.type === b.type && JSON.stringify(a.attrs ?? {}) === JSON.stringify(b.attrs ?? {})
}

/** The comark element a mark opens. */
function markToComarkElement(mark: Mark): ComarkElement {
  switch (mark.type) {
    case 'bold': return ['strong', {}]
    case 'italic': return ['em', {}]
    case 'strike': return ['del', {}]
    case 'underline': return ['u', { $: { html: 1, block: 0 } }]
    case 'code': return ['code', {}]
    default: return ['a', dropUnsetProps({ href: mark.attrs?.href ?? '', title: mark.attrs?.title })]
  }
}

/** Maps one editor inline node to comark nodes. */
function mapPmInlineNode(node: JSONContent): ComarkNode[] {
  const attrs = (node.attrs ?? {}) as Record<string, unknown>
  switch (node.type) {
    case 'text':
      return node.text ? [node.text] : []
    case 'hardBreak':
      return [['br', {}]]
    case 'mention': {
      const label = String(attrs.label ?? attrs.id ?? '')
      return attrs.id === null || attrs.id === undefined || attrs.id === ''
        ? [`@${label}`]
        : [['mention', { uid: String(attrs.id) }, label]]
    }
    case 'docLink': {
      const label = String(attrs.label ?? '')
      if (attrs.nid === null || attrs.nid === undefined) return label ? [label] : []
      return [[DOC_LINK_TAG, dropUnsetProps({ nid: String(attrs.nid), block: attrs.block }), ...(label ? [label] : [])]]
    }
    case CITATION_TAG: {
      const target = citeTarget(attrs)
      if (!target) return []
      return [[CITATION_TAG, target.kind === 'url'
        ? { url: target.url }
        : dropUnsetProps({ nid: String(target.nid), block: target.block, v: target.v })]]
    }
    case 'attachmentInline': {
      const label = String(attrs.label ?? '')
      if (!attrs.file) return label ? [label] : []
      return [['attachment', { file: attrs.file, ...INLINE }, ...(label ? [label] : [])]]
    }
    case 'image':
      return [attrs.file ? ['image', { ...fileImageComponentProps(attrs), ...INLINE }] : plainImageElement(attrs)]
    default: {
      const chip = listChipComponentDeclarations().find(declaration => chipFormOf(declaration.tag).node === node.type)
      if (!chip) return []
      const label = String(attrs.label ?? '')
      return [[chip.tag, writePropsFromNodeAttributes(chip, attrs), ...(chip.slot && label ? [label] : [])]]
    }
  }
}
