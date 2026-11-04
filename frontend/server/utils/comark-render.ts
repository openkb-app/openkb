import { Node as ProseNode } from '@tiptap/pm/model'
import { isHTMLTag, isMathMLTag, isSVGTag } from '@vue/shared'
import { comarkTreeToJson, parseMarkdownToComarkTree } from '../../app/comark/markdown-engine'
import { isRawHtml } from '../../app/comark/pm-mapper'
import type { ComarkNode } from '#shared/utils/comark-tree'
import { serializeCommitJSON, type ProseMirrorJSON } from './commit'
import { editorSchema } from './editor-schema'
import { splitTitleHeading, storedBody } from './title-heading'

/** Passes after which a body that still changes is returned as the last pass wrote it. */
const MAX_PASSES = 3

/**
 * Re-spells a stored body as the editor writes it: the title heading kept, the
 * rest loaded and written until it reads back as itself.
 *
 * Several passes, because an accepted comark gap can change a body again on the
 * next save (test/roundtrip/NORMALIZATIONS.md); a body that reads back as itself
 * opens in the editor with nothing to save.
 */
export async function renderStoredBody(stored: string): Promise<string> {
  const { titleHeading, body } = splitTitleHeading(stored)
  let rendered = body
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const next = rendered.trim() === ''
      ? ''
      : await serializeCommitJSON(await parseStoredBodyToJson(rendered))
    if (next === rendered) break
    rendered = next
  }
  return storedBody(titleHeading, undefined, rendered)
}

/**
 * Parses a stored body as the editor does, a tag naming no element read as text.
 *
 * A bare `<name>` in prose is a placeholder, and comark gives it the rest of its
 * container; the editor would drop that. Read as text, comark writes it `\<name>`.
 */
async function parseStoredBodyToJson(markdown: string): Promise<ProseMirrorJSON> {
  const json = comarkTreeToJson(spliceUnknownTagsAsText(await parseMarkdownToComarkTree(markdown)))
  return ProseNode.fromJSON(editorSchema, json).toJSON() as ProseMirrorJSON
}

/**
 * Replaces each raw HTML tag that names no HTML, SVG or MathML element
 * (`<agent name>`) by its source as text, followed by what comark nested into it.
 */
function spliceUnknownTagsAsText(nodes: ComarkNode[]): ComarkNode[] {
  return joinAdjacentText(nodes.flatMap((node): ComarkNode[] => {
    if (typeof node === 'string') return [node]
    const [tag, props, ...children] = node
    const spliced = spliceUnknownTagsAsText(children)
    if (!isRawHtml(node) || isHTMLTag(tag) || isSVGTag(tag) || isMathMLTag(tag)) return [[tag, props, ...spliced] as ComarkNode]
    const { $: _, ...attributes } = props
    const source = Object.entries(attributes).map(([name, value]) => value === true ? ` ${name}` : ` ${name}="${value}"`).join('')
    return [`<${tag}${source}>`, ...spliced]
  }))
}

/** Joins adjacent strings into one text node. */
function joinAdjacentText(nodes: ComarkNode[]): ComarkNode[] {
  return nodes.reduce<ComarkNode[]>((joined, node) => {
    const last = joined.at(-1)
    if (typeof node === 'string' && typeof last === 'string') joined[joined.length - 1] = last + node
    else joined.push(node)
    return joined
  }, [])
}

/**
 * An ordered-list marker, a component start (`::name`, `:name[`, `:name{`), an
 * attribute list, a link title, a stored mark tag, a raw `<img`, a word or a bracket.
 */
const TEXT_TOKEN = /^[ \t>]*\d{1,9}[.)](?=[ \t]|$)|::([A-Za-z][\w-]*)|:([A-Za-z][\w-]*)(?=[[{])|\{([^{}\n]*)\}|(?<=\]\([^\s()]*)[ \t]+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')(?=\))|(<\/?(u|strong|em|del)>)|<img\b|[\p{L}\p{N}]+|[[\]]/gmu

/** One entry of an attribute list: `#id`, `.class`, `name` or `name="value"`. */
const ATTRIBUTE = /([#.]?[^\s="'{}]+)(?:=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s}]+))?/gu

/** Lists the words of a text. */
function listWords(text: string): string[] {
  return text.match(/[\p{L}\p{N}]+/gu) ?? []
}

/**
 * The keys of an attribute list, entries sorted: `{name`, then `{name=word`
 * per word of its value. The `{` sets them apart from prose words.
 */
function listAttributeKeys(attributes: string): string[] {
  const entries = [...attributes.matchAll(ATTRIBUTE)]
    .map(([, name, value]) => [`{${name}`, ...listWords(value ?? '').map(word => `{${name}=${word}`)])
    .sort((a, b) => a.join(' ') < b.join(' ') ? -1 : 1)
  return entries.length > 0 ? entries.flat() : ['{}']
}

/** The mark tag names whose opening and closing tags in a text are as many. */
function listPairedMarkTags(text: string): Set<string> {
  const counts = new Map<string, number>()
  for (const [, closing, name] of text.matchAll(/<(\/?)(u|strong|em|del)>/g)) {
    counts.set(name!, (counts.get(name!) ?? 0) + (closing ? -1 : 1))
  }
  return new Set([...counts].filter(([, balance]) => balance === 0).map(([name]) => name))
}

/**
 * Lists the words, brackets, components, attribute lists and raw images of a text in order.
 *
 * - Brackets count because comark can read `[1]` in prose as a span.
 * - A component counts once whether written as a fence or inline.
 * - An attribute list counts as its entries, sorted: comark may write them in
 *   another order.
 * - A link title counts as a `title` entry: comark may move it into an attribute list.
 * - A mark tag whose name the text opens and closes as often does not count:
 *   it is a mark, like `**`. Any other mark tag counts.
 * - An ordered-list marker counts without its number: comark numbers the items.
 */
function listTextTokens(text: string): string[] {
  const pairedMarkTags = listPairedMarkTags(text)
  return [...text.matchAll(TEXT_TOKEN)].flatMap(([token, fence, inline, attributes, linkTitle, markTag, markName]) => {
    if (markTag !== undefined) return pairedMarkTags.has(markName!) ? [] : [markTag]
    if (fence ?? inline) return [`:${fence ?? inline}`]
    if (attributes !== undefined) return listAttributeKeys(attributes)
    if (linkTitle !== undefined) return listAttributeKeys(`title=${linkTitle}`)
    return [/^[ \t>]*\d/.test(token) ? '1.' : token]
  })
}

/** Whether two spellings of a body hold other words, brackets, components or raw images, or the same ones in another order. */
export function wordsBracketsComponentsOrImagesDiffer(before: string, after: string): boolean {
  const a = listTextTokens(before)
  const b = listTextTokens(after)
  return a.length !== b.length || a.some((token, i) => b[i] !== token)
}
