/**
 * The editor's markdown engine: comark markdown ⇄ ProseMirror, both
 * directions through @tiptap/markdown (marked lexer + per-extension
 * tokenizers/renderers), one grammar by construction.
 *
 * Sync and DOM-free — usable from the client editor session, the headless
 * commit service, and the round-trip corpus alike. The extension set is
 * the shared commit schema (server/utils/editor-schema.ts), so client and
 * server parse and serialize against the same node definitions.
 *
 * comark itself stays the read-page renderer, search-index feeder, and
 * S3 semantic referee (shared/utils/comark-tree.ts) — this module only
 * owns the editor load/save boundary.
 */
import { MarkdownManager } from '@tiptap/markdown'
import { Node as ProseNode } from '@tiptap/pm/model'
import type { JSONContent } from '@tiptap/core'
import { buildCommitSchemaExtensions, editorSchema } from '../../server/utils/editor-schema'
import { blockIdOf, liftBlockIds, lowerBlockIds } from '#shared/page-blocks'

let manager: MarkdownManager | undefined

/** The shared manager over the commit schema's extension set. */
export function markdownManager(): MarkdownManager {
  if (!manager) {
    manager = new MarkdownManager({
      extensions: buildCommitSchemaExtensions(),
      // Mirrors Nuxt UI's UEditor default (Editor.vue: markedOptions.gfm).
      markedOptions: { gfm: true },
    })
  }
  return manager
}

export function parseMarkdownToJson(markdown: string): JSONContent {
  // Lift trailing `{#id}` off native blocks onto attrs.id — the wire form
  // stays as comark emits it; the editor gains a structured block identifier.
  return adoptImageIds(liftBlockIds(normalizeToSchemaShape(markdownManager().parse(markdown))))
}

export function parseMarkdownToDoc(markdown: string): ProseNode {
  return ProseNode.fromJSON(editorSchema, parseMarkdownToJson(markdown))
}

export function serializeDocToMarkdown(doc: ProseNode | JSONContent): string {
  const json = doc instanceof ProseNode ? doc.toJSON() as JSONContent : doc
  // Lower attrs.id back to trailing `{#id}` text so the serializer emits the
  // id exactly where the read path (comark) puts it — byte-identical output.
  return markdownManager().serialize(lowerBlockIds(json))
}

const COMPONENT_NODES = new Set(['callout', 'infobox', 'image'])

/**
 * Rewrites parsed JSON into the shape the editor schema can represent —
 * the accepted lossy transforms the corpus encodes (Node.fromJSON does
 * not validate content models, so an invalid tree would round-trip in
 * tests but normalize differently in the live editor):
 *
 * - The image node is block-level: paragraphs holding inline images split
 *   into paragraph/image/paragraph runs, whitespace at the cut edges
 *   dropped.
 * - List items must start with a paragraph: an item whose entire content
 *   is components is hoisted out, splitting the list (ordered lists keep
 *   numbering via `start`).
 */
function normalizeToSchemaShape(doc: JSONContent): JSONContent {
  return { ...doc, content: normalizeBlocks(doc.content ?? []) }
}

function normalizeBlocks(blocks: JSONContent[]): JSONContent[] {
  return blocks.flatMap((block) => {
    if (block.type === 'paragraph' && (block.content ?? []).some(c => c.type === 'image')) {
      return splitParagraphAroundImages(block.content ?? [])
    }
    if ((block.type === 'bulletList' || block.type === 'orderedList')
      && (block.content ?? []).some(isComponentOnlyListItem)) {
      return splitListAroundComponentItems(block)
    }
    if (block.content) {
      return [{ ...block, content: normalizeBlocks(block.content) }]
    }
    return [block]
  })
}

function splitParagraphAroundImages(children: JSONContent[]): JSONContent[] {
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
  return result
}

/**
 * A plain image's `{#id}` trails it inside the paragraph comark reads its
 * line as, so the split leaves the id in an empty paragraph. Move it onto the
 * image and drop the paragraph. Any id-less image followed by an empty id
 * paragraph adopts it, also across a blank line.
 */
function adoptImageIds(doc: JSONContent): JSONContent {
  const blocks: JSONContent[] = []
  for (const block of doc.content ?? []) {
    const previous = blocks[blocks.length - 1]
    const id = blockIdOf(block)
    if (previous?.type === 'image' && !blockIdOf(previous)
      && block.type === 'paragraph' && id && (block.content ?? []).length === 0) {
      blocks[blocks.length - 1] = { ...previous, attrs: { ...previous.attrs, id } }
      continue
    }
    blocks.push(block)
  }
  return { ...doc, content: blocks }
}

function isComponentOnlyListItem(item: JSONContent): boolean {
  const children = item.content ?? []
  return item.type === 'listItem'
    && children.length > 0
    && children.every(c => COMPONENT_NODES.has(c.type ?? ''))
}

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
      result.push(...normalizeBlocks(item.content ?? []))
      position += 1
      runStart = position
    }
    else {
      run.push({ ...item, content: normalizeBlocks(item.content ?? []) })
      position += 1
    }
  }
  flushRun()
  return result
}
