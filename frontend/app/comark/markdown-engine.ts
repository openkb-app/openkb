/**
 * The editor's markdown engine: comark parses and renders, `pm-mapper.ts`
 * maps comark's tree to the editor's ProseMirror JSON and back. The read page
 * parses with the same comark, so editor and read page share one grammar.
 *
 * DOM-free: used by the client editor session, the headless commit service
 * and the round-trip corpus alike.
 */
import { Node as ProseNode } from '@tiptap/pm/model'
import type { JSONContent } from '@tiptap/core'
import { editorSchema } from '../../server/utils/editor-schema'
import { parseComark, type ComarkNode } from '#shared/utils/comark-tree'
import { comarkToPm, pmToComark } from './pm-mapper'
import { escapeBareBraces, renderHandlers } from './render-handlers'

/** Parses stored markdown with comark into the editor's ProseMirror JSON. */
export async function parseMarkdownToJson(markdown: string): Promise<JSONContent> {
  return comarkTreeToJson(await parseMarkdownToComarkTree(markdown))
}

/** Parses stored markdown into comark's tree, as the editor reads it. */
export function parseMarkdownToComarkTree(markdown: string): Promise<ComarkNode[]> {
  return parseComark(markdown, { headingIds: false })
}

/** Maps comark's tree to the editor's ProseMirror JSON. */
export function comarkTreeToJson(nodes: ComarkNode[]): JSONContent {
  return normalizeToSchemaShape(trimTextblockEdges(comarkToPm(nodes)))
}

/** Parses stored markdown into a ProseMirror document of the editor schema. */
export async function parseMarkdownToDoc(markdown: string): Promise<ProseNode> {
  return ProseNode.fromJSON(editorSchema, await parseMarkdownToJson(markdown))
}

/**
 * Loads the renderer chunk ahead of a copy: a clipboard write after an awaited
 * chunk load can lose the click's user activation (Safari).
 */
export function preloadMarkdownRenderer(): void {
  void import('comark/render')
}

/** Writes a ProseMirror document as markdown with comark's renderer. */
export async function serializeDocToMarkdown(doc: ProseNode | JSONContent): Promise<string> {
  const json = doc instanceof ProseNode ? doc.toJSON() as JSONContent : doc
  const { renderMarkdown } = await import('comark/render')
  const nodes = escapeBareBraces(pmToComark(dropTrailingEmptyParagraphs(trimTextblockEdges(json))))
  if (nodes.length === 0) return ''
  // Props stay on the fence line: the block splitters (`block-versions.ts`, `PageBlocks.php`) read a block's id there.
  const markdown = await renderMarkdown({ nodes } as never, { components: renderHandlers, maxInlineAttributes: Infinity } as never)
  return markdown.replace(/\n+$/, '')
}

/**
 * Drops the empty paragraphs a document ends on: they show nothing, and the
 * editor's trailing node adds one to every page ending in another block, so
 * writing it would make a visit look like an edit.
 */
function dropTrailingEmptyParagraphs(doc: JSONContent): JSONContent {
  const content = [...(doc.content ?? [])]
  while (content.at(-1)?.type === 'paragraph' && !content.at(-1)?.content?.length) content.pop()
  return { ...doc, content }
}

/**
 * Drops the spaces, tabs, line breaks and hard breaks a textblock starts or
 * ends on, and the spaces and tabs around a hard break or a line break in its
 * text. A heading's hard break is a space: an ATX heading is one line.
 *
 * Drupal diffs stored bytes per block, so a body has to read back to the same
 * bytes. The parser drops whitespace at a line's edges or, from a tab or four
 * spaces on, reads the block as code — either way a change nobody typed.
 */
function trimTextblockEdges(node: JSONContent): JSONContent {
  if (!node.content) return node
  const type = editorSchema.nodes[node.type ?? '']
  if (!type?.isTextblock || type.spec.code) {
    return { ...node, content: node.content.map(trimTextblockEdges) }
  }
  const lines = node.content.map((child) => {
    if (child.type === 'hardBreak' && node.type === 'heading') return { ...child, type: 'text', text: ' ' }
    return child.type === 'text' && child.text
      ? { ...child, text: child.text.replace(/[ \t]*\n[ \t]*/g, '\n') }
      : child
  })
  const content = trimInlineEdge(trimInlineEdge(trimWhitespaceAroundBreaks(lines), 'end'), 'start')
  if (!content.length) {
    const { content: _, ...empty } = node
    return empty
  }
  return { ...node, content }
}

/** Trims the spaces and tabs around each hard break, line by line. */
function trimWhitespaceAroundBreaks(content: JSONContent[]): JSONContent[] {
  const lines: JSONContent[][] = [[]]
  for (const node of content) {
    if (node.type === 'hardBreak') lines.push([node], [])
    else lines.at(-1)!.push(node)
  }
  return lines.flatMap((line, index) => line[0]?.type === 'hardBreak'
    ? line
    : trimInlineEdge(trimInlineEdge(line, index < lines.length - 1 ? 'end' : 'none'), index > 0 ? 'start' : 'none'))
}

/** Drops whitespace text and hard breaks from one edge of a run of inline nodes. */
function trimInlineEdge(content: JSONContent[], edge: 'start' | 'end' | 'none'): JSONContent[] {
  if (edge === 'none') return content
  const at = edge === 'start' ? 0 : -1
  const pattern = edge === 'start' ? /^[ \t\n]+/ : /[ \t\n]+$/
  for (let node = content.at(at); node?.type === 'text' || node?.type === 'hardBreak'; node = content.at(at)) {
    const text = node.type === 'text' ? (node.text ?? '').replace(pattern, '') : ''
    if (text !== '') {
      content.splice(at, 1, { ...node, text })
      break
    }
    content.splice(at, 1)
  }
  return content
}

const COMPONENT_NODES = new Set(['callout', 'infobox', 'image', 'attachment', 'embed'])

/**
 * Rewrites parsed JSON into the shape the editor schema can represent —
 * the accepted lossy transforms the corpus encodes:
 *
 * - The image node is block-level: paragraphs holding inline images split
 *   into paragraph/image/paragraph runs, whitespace at the cut edges
 *   dropped.
 * - List items must start with a paragraph: an item whose entire content
 *   is components is hoisted out, splitting the list (ordered lists keep
 *   numbering via `start`).
 */
function normalizeToSchemaShape(doc: JSONContent): JSONContent {
  return { ...doc, content: normalizeBlocksToSchemaShape(doc.content ?? []) }
}

/** Rewrites blocks into shapes the editor schema holds: images out of paragraphs, components out of list items. */
function normalizeBlocksToSchemaShape(blocks: JSONContent[]): JSONContent[] {
  return blocks.flatMap((block) => {
    if (block.type === 'paragraph' && (block.content ?? []).some(c => c.type === 'image')) {
      return splitParagraphAroundImages(block)
    }
    if ((block.type === 'bulletList' || block.type === 'orderedList')
      && (block.content ?? []).some(isComponentOnlyListItem)) {
      return splitListAroundComponentItems(block)
    }
    if (block.content) {
      return [{ ...block, content: normalizeBlocksToSchemaShape(block.content) }]
    }
    return [block]
  })
}

/** The paragraph's id stays on the last piece, where it trailed the line. */
function splitParagraphAroundImages(paragraph: JSONContent): JSONContent[] {
  const children = paragraph.content ?? []
  const result: JSONContent[] = []
  let run: JSONContent[] = []

  const flushRun = () => {
    const first = run[0]
    if (first?.type === 'text' && first.text) {
      run[0] = { ...first, text: first.text.replace(/^\s+/, '') }
    }
    const last = run[run.length - 1]
    if (last?.type === 'text' && last.text) {
      run[run.length - 1] = { ...last, text: last.text.replace(/\s+$/, '') }
    }
    run = run.filter(c => !(c.type === 'text' && c.text === ''))
    if (run.length > 0) result.push({ type: 'paragraph', content: run })
    run = []
  }

  for (const child of children) {
    if (child.type === 'image') {
      flushRun()
      result.push(child)
    }
    else {
      run.push(child)
    }
  }
  flushRun()
  const id = paragraph.attrs?.id
  const last = result.at(-1)
  if (id && last) result[result.length - 1] = { ...last, attrs: { ...last.attrs, id } }
  return result
}

/** An item's blocks without the empty paragraph that leads a non-paragraph block. */
function listItemBlocks(item: JSONContent): JSONContent[] {
  const [first, ...rest] = item.content ?? []
  return first?.type === 'paragraph' && !first.content?.length && rest.length > 0 ? rest : item.content ?? []
}

/** Whether a list item holds nothing but components. */
function isComponentOnlyListItem(item: JSONContent): boolean {
  const children = listItemBlocks(item)
  return item.type === 'listItem'
    && children.length > 0
    && children.every(c => COMPONENT_NODES.has(c.type ?? ''))
}

/** Splits a list around its component-only items, which become blocks of their own; numbering carries on. */
function splitListAroundComponentItems(list: JSONContent): JSONContent[] {
  const result: JSONContent[] = []
  let run: JSONContent[] = []
  let position = Number((list.attrs as { start?: number } | undefined)?.start ?? 1)
  let runStart = position

  const flushRun = () => {
    if (run.length > 0) {
      const attrs = { ...list.attrs }
      delete attrs.start
      if (list.type === 'orderedList' && runStart !== 1) attrs.start = runStart
      result.push({
        ...list,
        ...(Object.keys(attrs).length > 0 ? { attrs } : { attrs: undefined }),
        content: run,
      })
      run = []
    }
    runStart = position
  }

  for (const item of list.content ?? []) {
    if (isComponentOnlyListItem(item)) {
      flushRun()
      result.push(...normalizeBlocksToSchemaShape(listItemBlocks(item)))
      position += 1
      runStart = position
    }
    else {
      run.push({ ...item, content: normalizeBlocksToSchemaShape(item.content ?? []) })
      position += 1
    }
  }
  flushRun()
  return result
}
