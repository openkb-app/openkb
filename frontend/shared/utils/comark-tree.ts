/**
 * Comark tree passes, shared by the read path (server-side CE enrichment) and
 * the chat surfaces (client-side, per streamed chunk).
 *
 * The parser's tree is what the page renders — `@comark/vue`'s
 * `MarkdownDocument` mounts every node, HTML elements as themselves and
 * component tags as the Vue components the map names. So everything this
 * module does is tree → tree: resolve what only the server knows, rewrite what
 * the renderer must not be handed, and leave the shape alone.
 *
 * The passes:
 * - `::block{#id}` wrapper fences dissolve into their children.
 * - `::image{media="…"}` UUIDs resolve through the caller's resolver in one
 *   batch, `doc` components (`:doc[Label]{nid="42"}`, shared/utils/doc-links.ts)
 *   likewise. The doc resolver is the reader's own: a reader who may see the
 *   target gets its live title, one who may not gets the author's stored label.
 * - `citation` components (`:citation{nid="42" block="b-4f2a" v="…"}`,
 *   shared/utils/citations.ts) resolve the same way, with the cited pages'
 *   current block versions, and become numbered chips — the number handed out
 *   here, never stored. {@link citationsByBlock} reads each block's own
 *   sources back off the result, and {@link referencesByBlock} reads the
 *   edges a block holds off the parsed tree, for the chunk index.
 * - Tags whose source is not prose are dropped, and everything else is held to
 *   the text format's allowed list (`allowedHtml`, from `GET /openkb/schema`):
 *   an unlisted tag unwraps to its children, an unlisted attribute drops, and a
 *   value-restricted attribute keeps only the values the list carries. HTML
 *   elements and component nodes go through the one filter — the renderer hands
 *   what it is given straight to the DOM.
 * - A component nobody has built becomes `unknown`, so a fence can never name
 *   an app component into the page.
 * - Read path only: every id-bearing top-level block gets a ¶ link.
 *
 * {@link dataImages} widens the parser's `data:` check.
 */
import { BLOCK_ID_PREFIX } from '#shared/page-blocks'
import { MEDIA_UUID_RE, type ResolvedMedia } from './media'
import { DOC_LINK_TAG, docLinkHref, docLinkTarget, type ResolvedDoc } from '#shared/utils/doc-links'
import {
  CITATION_TAG,
  citeKey,
  citeState,
  citeTarget,
  citeUrlTitle,
  type CiteState,
} from '#shared/utils/citations'

/** What one attribute may carry: any value, or only the listed ones. */
export type AttrRule = true | Record<string, true>

/**
 * What the text format allows per tag, `*` holding what applies to every tag.
 * A trailing `*` globs, on an attribute name and on a value alike; `true` for
 * a whole tag is "any attribute".
 */
export type AllowedHtml = Record<string, true | Record<string, AttrRule>>

export type ComarkProps = Record<string, unknown>
export type ComarkNode = string | [tag: string, props: ComarkProps, ...children: ComarkNode[]]

/** One source an answer cited, as much of it as a chip shows. */
export interface CitationChip {
  n: number
  title?: string
  /** Where the chip leads, anchored on the cited block. A chip without one is not rendered. */
  path?: string
}

/** A cited page, as resolving one citation's target answers it. */
export interface ResolvedCite extends ResolvedDoc {
  /** The page's block id → current version, for the comparison staleness is. */
  versions: Record<string, string>
}

/** One source a block cites, as the chip and the block's card state it. */
export interface CitationSource {
  n: string
  title: string
  /** Absent for a citation whose page did not resolve: there is nowhere to send the reader. */
  path?: string
  /** Absent while the citation still reads as it was made. */
  state?: Exclude<CiteState, 'ok'>
}

/**
 * What one block references: the sources it cites, and the pages it links to.
 *
 * Two lists rather than one, because they say different things: a citation
 * carries provenance and can go stale, a link is navigation and cannot.
 *
 * An edge names a page as `"42"` and one of its blocks as `"42#b-4f2a"`; a
 * block-level reference carries both, so one term answers "what references
 * this page" and one "what references this block". A citation of a source
 * outside the knowledge base is no edge: there is nothing to look back from.
 */
export interface BlockReferences {
  cites: string[]
  links: string[]
}

/** The tag an unbuilt component renders under. See `CustomDefault`. */
export const UNKNOWN_TAG = 'unknown'

/**
 * HTML elements emitted by comark's CommonMark/GFM parsing. Anything
 * not in this set is treated as an MDC component.
 */
export const HTML_ELEMENTS = new Set([
  // block
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'div', 'section', 'article', 'aside',
  'ul', 'ol', 'li',
  'blockquote', 'pre', 'hr',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  // inline
  'em', 'strong', 'code', 'del', 'ins', 'sub', 'sup', 'mark',
  'a', 'img', 'br', 'span',
  'kbd', 'abbr', 'u',
  'input', // task lists
])

/** The component tags the page has a renderer for. */
export const COMPONENT_TAGS = new Set(['callout', 'infobox', 'image', DOC_LINK_TAG])

/**
 * Tags dropped with their content. comark parses raw `<script>`, `<style>`,
 * `<template>`, `<iframe>` as MDC components, and their source is not prose.
 */
const DROPPED_TAGS = new Set(['script', 'style', 'template', 'iframe', 'object', 'embed'])

/**
 * Block tags the ¶ fragment link is emitted into. It is a phrasing-content
 * child of the block itself, so it is only valid where phrasing is: a list,
 * table or code fence stays addressable by its id but carries no affordance.
 */
const LINKABLE_BLOCKS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p'])

/** How much of a block's own text its link quotes. */
const LINK_NAME_LIMIT = 48

export type MediaResolver = (uuids: string[]) => Promise<Record<string, ResolvedMedia>>
export type DocResolver = (nids: number[]) => Promise<Record<number, ResolvedDoc>>
export type CiteResolver = (nids: number[]) => Promise<Record<number, ResolvedCite>>

export interface TreeOptions {
  /** Resolves `::image{media="…"}` UUIDs to render URLs, in one batch. */
  resolveMedia?: MediaResolver
  /**
   * Resolves `:doc[…]{nid="…"}` targets, in one batch and under the caller's
   * own auth carrier, so the rendering is per reader.
   */
  resolveDocs?: DocResolver
  /**
   * Resolves `:citation{nid="…"}` targets, the same way and under the same
   * carrier, plus the targets' current block versions — which is what says
   * whether a citation still reads as it was made. Without it a citation
   * renders as nothing: the index holds the page's words, not its chrome.
   */
  resolveCites?: CiteResolver
  /** See {@link withBlockLinks}. Read path only. */
  blockLinks?: boolean
  /**
   * The sources a bare `[n]` may be rendered as a citation chip for. Chat only
   * — a page cites in prose. A marker naming a number they lack is put
   * back as it was written, so a chip always leads somewhere.
   *
   * An authored `[label]{.cls}` span carries attributes and is left alone.
   */
  citationChips?: readonly CitationChip[]
  /**
   * The text format's allowed list, as `GET /openkb/schema` publishes it.
   * Absent — the schema was unreachable — leaves the built-in checks as the
   * floor, so a page still renders.
   */
  allowedHtml?: AllowedHtml
}

/** One markdown-it inline rule, as its ruler holds it. */
type InlineRule = (state: unknown, silent: boolean) => boolean

/** What {@link dataImages} touches on the markdown-it instance. */
interface ImageRuleHost {
  validateLink: (url: string) => boolean
  inline: {
    ruler: {
      at: (name: string, fn: InlineRule) => void
      __rules__: { name: string, fn: InlineRule }[]
    }
  }
}

/**
 * Widens the parser's `data:` check to `data:image/*`, matching `isSafeAttr`.
 * markdown-it's own list is raster-only, and shares the check with links, so it
 * is widened only while the image rule runs.
 */
export const dataImages = {
  name: 'openkb-data-images',
  markdownItPlugins: [(md: ImageRuleHost) => {
    const image = md.inline.ruler.__rules__.find(rule => rule.name === 'image')?.fn
    if (!image) return
    let forImage = false
    const inherited = md.validateLink.bind(md)
    md.validateLink = (url: string) => (forImage && isDataImage(url)) || inherited(url)
    md.inline.ruler.at('image', (state, silent) => {
      forImage = true
      try {
        return image(state, silent)
      }
      finally {
        forImage = false
      }
    })
  }],
}

/** The page body, or one chat answer, as the page renders it. */
export async function markdownToTree(
  markdown: string,
  options: TreeOptions = {},
): Promise<ComarkNode[]> {
  return cleanTree(await parseComark(markdown), options)
}

/**
 * The document as comark parses it, `::block{#id}` wrappers dissolved.
 *
 * The tree before anything is resolved or filtered, which is where a caller
 * reads the reference nodes off: {@link cleanTree} renders a citation as a
 * chip and, with nothing to resolve it against, as nothing at all.
 */
export async function parseComark(markdown: string): Promise<ComarkNode[]> {
  if (!markdown || !markdown.trim()) return []
  // Dynamic so the parser is its own chunk: the read page is handed a tree
  // the server already built, and only the chat surfaces parse in the browser.
  const { parseMarkdown } = await import('comark')
  return dissolveBlockFences((await parseMarkdown(markdown, { plugins: [dataImages] })).nodes as ComarkNode[])
}

/** The passes {@link markdownToTree} runs, over a tree already parsed. */
export async function cleanTree(
  nodes: ComarkNode[],
  options: TreeOptions = {},
): Promise<ComarkNode[]> {
  if (nodes.length === 0) return []
  const uuids = collectMediaUuids(nodes)
  const docNids = collectDocNids(nodes)
  const citedNids = options.resolveCites ? collectCiteNids(nodes) : []
  // Two reads, not one: resolving a citation reads the cited page's whole body
  // to hash its blocks, and a document link needs none of that.
  const [media, docs, cited] = await Promise.all([
    uuids.length > 0 && options.resolveMedia ? options.resolveMedia(uuids) : {},
    docNids.length > 0 && options.resolveDocs ? options.resolveDocs(docNids) : {},
    citedNids.length > 0 && options.resolveCites ? options.resolveCites(citedNids) : {},
  ])
  const ctx: PassContext = {
    media,
    docs,
    cites: options.resolveCites ? { resolved: cited, numbers: new Map() } : undefined,
    citationChips: options.citationChips,
    allowed: options.allowedHtml,
  }
  const clean = cleanChildren(nodes, ctx, false)
  return options.blockLinks ? withBlockLinks(clean) : clean
}

/** What the passes carry down: everything resolved up front, plus the switches. */
interface PassContext {
  media: Record<string, ResolvedMedia>
  docs: Record<number, ResolvedDoc>
  /** The cited pages, and the numbers handed out so far. Absent drops citations. */
  cites?: { resolved: Record<number, ResolvedCite>, numbers: Map<string, number> }
  citationChips?: readonly CitationChip[]
  allowed?: AllowedHtml
}

/**
 * One level of the tree, rewritten. `inline` says a component here sits in
 * phrasing content and may not render a block box of its own (ADR 0012): it is
 * set under any HTML element and propagates through inline components. The tree
 * spells `> ::callout` and `:callout[…]` alike, so the ambiguous cases resolve
 * to inline — phrasing content is valid wherever a block box would be.
 */
function cleanChildren(nodes: ComarkNode[], ctx: PassContext, inline: boolean): ComarkNode[] {
  return nodes.flatMap(node => cleanNode(node, ctx, inline))
}

/** One node, as zero (dropped), one, or — an unlisted tag — its children. */
function cleanNode(node: ComarkNode, ctx: PassContext, inline: boolean): ComarkNode[] {
  if (typeof node === 'string') return ctx.citationChips ? citedText(node, ctx.citationChips) : [node]
  const [tag, rawProps, ...children] = node
  if (DROPPED_TAGS.has(tag)) return []
  if (ctx.citationChips && isCitationRef(node)) return chipsFor(`[${node[2]}]`, ctx.citationChips)
  // A tag the format does not list is not the author's to write: the words
  // below it stay, the element itself does not. A void tag has no children,
  // so the same rule drops it.
  if (ctx.allowed && !Object.hasOwn(ctx.allowed, tag)) return cleanChildren(children, ctx, inline)
  const props = allowedProps(tag, plainBindings(tag, rawProps ?? {}), ctx.allowed)

  if (tag === DOC_LINK_TAG) return [docLinkNode(props, children, ctx)]
  // A citation naming no source is not this component: it unwraps to the words
  // it holds, as any tag the format does not list does.
  if (tag === CITATION_TAG) return citeNode(props, ctx) ?? cleanChildren(children, ctx, true)
  // An anchor the attribute filter stripped the href from is not a link.
  if (tag === 'a' && props.href === undefined) return [['span', props, ...cleanChildren(children, ctx, true)]]
  if (HTML_ELEMENTS.has(tag)) {
    // A `[1]` inside code is code, not a citation.
    const inner = tag === 'code' || tag === 'pre' ? { ...ctx, citationChips: undefined } : ctx
    const element: ComarkNode = [tag, props, ...cleanChildren(children, inner, true)]
    return [isTaskItem(tag, rawProps ?? {}) ? withTaskLabel(element) : element]
  }

  // A component keeps its tag where the page has a renderer for it and takes
  // the fallback otherwise, so a fence can never name an app component into
  // the page. `inline` is ours to say: an attribute of that name is already
  // gone, so it cannot make a block component render as phrasing or back.
  // Children carry the component's own flag: what sits inside an inline
  // component is phrasing content too.
  const known = COMPONENT_TAGS.has(tag)
  const own = tag === 'image' ? imageProps(props, ctx.media) : props
  return [[
    known ? tag : UNKNOWN_TAG,
    { ...own, ...(known ? {} : { name: tag }), ...(inline ? { inline: true } : {}) },
    ...cleanChildren(children, ctx, inline),
  ]]
}

/** A GFM task-list item, by the class comark's own parsing puts on it. */
function isTaskItem(tag: string, props: ComarkProps): boolean {
  return tag === 'li' && String(props.class ?? '').includes('task-list-item')
}

/**
 * Name the checkbox comark renders for a task-list item.
 *
 * The plugin emits a bare `<input type="checkbox">` in front of the item text,
 * so without this every task item is a form control a screen reader announces
 * as "checkbox, checked" and nothing more. The item's own text is the name.
 */
function withTaskLabel(node: ComarkNode): ComarkNode {
  if (typeof node === 'string') return node
  const [tag, props, ...children] = node
  return [tag, props, ...children.map((child) => {
    if (typeof child === 'string' || child[0] !== 'input' || child[1].type !== 'checkbox') return child
    return [child[0], { ...child[1], 'aria-label': collectText(children).trim() }] as ComarkNode
  })]
}

/**
 * One citation, as the chip a reader sees: its number, where it leads, and
 * whether it still reads as it was made.
 *
 * The number is this pass's, handed out in document order and once per target,
 * so two citations of one block carry one number. The version stays the
 * node's, so two blocks that cite one source at different versions share a
 * number and say separately how each of them stands. Without a resolver there
 * is nothing to number against and the citation renders as nothing — which is
 * what the indexable projection wants.
 *
 * Null for props naming no source, which is not a citation at all.
 */
function citeNode(props: ComarkProps, ctx: PassContext): ComarkNode[] | null {
  const target = citeTarget(props)
  if (!target) return null
  const cites = ctx.cites
  if (!cites) return []
  const key = citeKey(target)
  const n = cites.numbers.get(key) ?? cites.numbers.size + 1
  cites.numbers.set(key, n)

  if (target.kind === 'url') {
    return [[CITATION_TAG, { n: String(n), title: citeUrlTitle(target.url), path: target.url }]]
  }
  const resolved = cites.resolved[target.nid]
  const state = citeState(target, resolved?.versions ?? null)
  // A chip leads where the reader can go: the block, or — its block gone —
  // the page, or nowhere at all when the page itself did not resolve.
  const path = resolved
    ? docLinkHref(target.nid, resolved.path, state === 'dangling' ? null : target.block)
    : ''
  return [[CITATION_TAG, {
    n: String(n),
    title: resolved?.title ?? '',
    ...(path === '' ? {} : { path }),
    ...(state === 'ok' ? {} : { state }),
  }]]
}

/**
 * What one document link renders: the resolved view, or — for a component
 * naming no page — the words it wrapped, which is not a link at all.
 */
function docLinkNode(props: ComarkProps, children: ComarkNode[], ctx: PassContext): ComarkNode {
  const view = docLinkView(props, children, ctx.docs)
  if (!view) return collectText(children).trim()
  const { words, ...link } = view
  return [DOC_LINK_TAG, link, words]
}

/** What one marker names: `1`, or `2, 3` written as a single marker. */
const CITE_NUMBERS = /^\d+(?:\s*,\s*\d+)*$/

/** The same, as it sits in a text node. */
const CITE_IN_TEXT = /\[(\d+(?:\s*,\s*\d+)*)\]/g

/**
 * A bare `[7]` or `[2, 3]` in the prose: an attribute-less span of digits.
 *
 * comark's MDC span syntax eats the brackets, so by the time attributes exist
 * the literal marker is gone.
 */
function isCitationRef(node: ComarkNode): node is [string, ComarkProps, string] {
  return typeof node !== 'string'
    && node[0] === 'span'
    && Object.keys(node[1] ?? {}).length === 0
    && node.length === 3
    && typeof node[2] === 'string'
    && CITE_NUMBERS.test(node[2])
}

/**
 * The markers one text node still carries, as chips.
 *
 * Only the last of `[1][2]` parses as a span: markdown reads the ones before
 * it as reference links and, finding no definition, writes them back as text.
 */
function citedText(text: string, cited: readonly CitationChip[]): ComarkNode[] {
  const out: ComarkNode[] = []
  let read = 0
  for (const match of text.matchAll(CITE_IN_TEXT)) {
    if (match.index > read) out.push(text.slice(read, match.index))
    out.push(...chipsFor(match[0], cited))
    read = match.index + match[0].length
  }
  if (read === 0) return [text]
  if (read < text.length) out.push(text.slice(read))
  return out
}

/**
 * One marker's numbers as chips.
 *
 * A marker whose numbers are not all cited stays text, as written. A chip is a
 * link, so a source with no path is no better than an uncited number.
 */
function chipsFor(marker: string, cited: readonly CitationChip[]): ComarkNode[] {
  const chips: ComarkNode[] = []
  for (const part of marker.slice(1, -1).split(',')) {
    const n = part.trim()
    const source = cited.find(c => String(c.n) === n)
    if (!source?.path) return [marker]
    chips.push([CITATION_TAG, { n, title: source.title ?? '', path: source.path }])
  }
  return chips
}

/**
 * What one block's link is called.
 *
 * By the block's own opening words, so a screen reader's list of links is a
 * list of places rather than forty identical "Link to this block" entries
 * (WCAG 2.4.4). The link sits inside its block, so a heading's own accessible
 * name ends up repeating those words — the cost of naming the link at all,
 * paid where the alternative is a name that says nothing. A block with no
 * words to quote (a bare image) keeps the generic name.
 *
 * Sliced by code point: a name cut through a surrogate pair ends in a
 * replacement character.
 */
function blockLinkLabel(children: ComarkNode[]): string {
  const words = collectText(children).replace(/\s+/g, ' ').trim()
  if (!words) return 'Link to this block'
  const points = [...words]
  const quoted = points.length > LINK_NAME_LIMIT
    ? `${points.slice(0, LINK_NAME_LIMIT).join('').trimEnd()}…`
    : words
  return `Link to block: ${quoted}`
}

/**
 * Give every id-bearing top-level block a link to itself.
 *
 * Read path only — the indexable projection walks the same nodes and must
 * index the page's words, not its chrome. The anchor is a real `<a href>`,
 * so the fragment works with no JavaScript; `main.css` draws it in the margin
 * and reveals it on hover/focus.
 */
function withBlockLinks(nodes: ComarkNode[]): ComarkNode[] {
  return nodes.map((node) => {
    if (typeof node === 'string') return node
    const [tag, props, ...children] = node
    const id = props?.id
    if (!LINKABLE_BLOCKS.has(tag) || typeof id !== 'string' || !id.startsWith(BLOCK_ID_PREFIX)) return node
    const link: ComarkNode = ['a', {
      'class': 'okb-block-link',
      'href': `#${id}`,
      'aria-label': blockLinkLabel(children),
    }, '¶']
    return [tag, props, ...children, link] as ComarkNode
  })
}

/**
 * A `::block{#id}` wrapper fence is serialization plumbing, not content: it
 * exists so containers comark has no attribute syntax for (tables, lists,
 * code fences — see shared/page-blocks.ts) can carry a review id. On the
 * read side it dissolves into its children, the id landing on the first
 * element child that has none of its own — `<table id="b-…">` — which is the
 * DOM anchor block cards and bylines address.
 */
function dissolveBlockFences(nodes: ComarkNode[]): ComarkNode[] {
  return nodes.flatMap((node) => {
    if (typeof node === 'string') return [node]
    const [tag, props, ...children] = node
    if (tag !== 'block') {
      return [[tag, props, ...dissolveBlockFences(children)] as ComarkNode]
    }
    const inner = dissolveBlockFences(children)
    const id = typeof props?.id === 'string' && props.id !== '' ? props.id : undefined
    if (!id) return inner
    let placed = false
    return inner.map((child) => {
      if (placed || typeof child === 'string') return child
      placed = true
      const [childTag, childProps, ...grandchildren] = child
      return typeof childProps?.id === 'string' && childProps.id !== ''
        ? child
        : [childTag, { ...(childProps ?? {}), id }, ...grandchildren] as ComarkNode
    })
  })
}

/** Only well-formed ids are collected — see {@link MEDIA_UUID_RE}. */
function collectMediaUuids(nodes: ComarkNode[], out: Set<string> = new Set()): string[] {
  for (const node of nodes) {
    if (typeof node === 'string') continue
    const [tag, props, ...children] = node
    if (tag === 'image' && typeof props?.media === 'string' && MEDIA_UUID_RE.test(props.media)) {
      out.add(props.media)
    }
    collectMediaUuids(children, out)
  }
  return [...out]
}

/** The pages a body cites, once each. An external citation resolves nothing. */
function collectCiteNids(nodes: ComarkNode[], out: Set<number> = new Set()): number[] {
  for (const node of nodes) {
    if (typeof node === 'string') continue
    const [tag, props, ...children] = node
    if (tag === CITATION_TAG) {
      const target = citeTarget(props ?? {})
      if (target?.kind === 'doc') out.add(target.nid)
    }
    collectCiteNids(children, out)
  }
  return [...out]
}

function collectDocNids(nodes: ComarkNode[], out: Set<number> = new Set()): number[] {
  for (const node of nodes) {
    if (typeof node === 'string') continue
    const [tag, props, ...children] = node
    if (tag === DOC_LINK_TAG) {
      const target = docLinkTarget(props ?? {})
      if (target) out.add(target.nid)
    }
    collectDocNids(children, out)
  }
  return [...out]
}

/** What one document link renders from, once the reader's resolution is in. */
interface DocLinkView {
  href: string
  words: string
  nid: number
  block?: string
  title?: string
}

/**
 * One document link, resolved.
 *
 * Unresolved, which covers an unreadable and a deleted target alike, it is the
 * stored label and `/node/<nid>`. Resolved, a page link takes the live title
 * and a block link keeps the stored label with the title as its tooltip.
 * `nid`/`block` mirror the editor's own node, so a pasted copy keeps its
 * target. Null for a component naming no page: not a link at all.
 */
function docLinkView(props: ComarkProps, children: ComarkNode[], docs: Record<number, ResolvedDoc>): DocLinkView | null {
  const target = docLinkTarget(props)
  if (!target) return null
  const resolved = docs[target.nid]
  const label = collectText(children).trim()
  return {
    href: docLinkHref(target.nid, resolved?.path ?? null, target.block),
    words: resolved && !target.block ? resolved.title : label,
    nid: target.nid,
    block: target.block ?? undefined,
    title: resolved && target.block ? resolved.title : undefined,
  }
}

/**
 * The body's leading title heading, with its block id lifted off it.
 *
 * The page's own `<h1>` spells the title, so the body's copy of the heading is
 * hidden, and a hidden element is no fragment target. The id belongs on the
 * heading a reader can see, and an id may be spelled only once, so the ¶ that
 * links the block to itself comes off with it.
 */
export function liftTitleBlockId(
  nodes: readonly ComarkNode[],
): { titleBlockId: string, nodes: ComarkNode[] } {
  const [head, ...rest] = nodes
  const id = Array.isArray(head) && head[0] === 'h1' ? head[1].id : undefined
  if (!Array.isArray(head) || typeof id !== 'string' || !id.startsWith(BLOCK_ID_PREFIX)) {
    return { titleBlockId: '', nodes: [...nodes] }
  }
  const { id: _lifted, ...props } = head[1]
  const children = (head.slice(2) as ComarkNode[]).filter(child => !isBlockLink(child))
  return { titleBlockId: id, nodes: [[head[0], props, ...children], ...rest] }
}

/** The ¶ {@link withBlockLinks} appends — an affordance for an id, not words. */
function isBlockLink(node: ComarkNode): boolean {
  return Array.isArray(node) && node[0] === 'a' && node[1]?.class === 'okb-block-link'
}

/**
 * Each block's own sources, in the order that block cites them.
 *
 * A projection of the rendered tree: the chips are the edges, so this list
 * cannot disagree with the prose. Keyed by the block id the rendered body
 * carries, which is the id a block card addresses.
 */
export function citationsByBlock(nodes: readonly ComarkNode[]): Record<string, CitationSource[]> {
  const out: Record<string, CitationSource[]> = {}
  for (const node of nodes) {
    if (typeof node === 'string') continue
    const id = node[1]?.id
    if (typeof id !== 'string' || !id.startsWith(BLOCK_ID_PREFIX)) continue
    const sources = new Map<string, CitationSource>()
    collectCitations(node.slice(2) as ComarkNode[], sources)
    if (sources.size > 0) out[id] = [...sources.values()]
  }
  return out
}

/**
 * Every id-bearing top-level block's references, in document order.
 *
 * Read off the parsed tree ({@link parseComark}), where the reference nodes
 * still are. A block referencing nothing is left out.
 */
export function referencesByBlock(nodes: readonly ComarkNode[]): Record<string, BlockReferences> {
  const out: Record<string, BlockReferences> = {}
  for (const node of nodes) {
    if (typeof node === 'string') continue
    const id = node[1]?.id
    if (typeof id !== 'string' || !id.startsWith(BLOCK_ID_PREFIX)) continue
    const cites = new Set<string>()
    const links = new Set<string>()
    collectReferences(node.slice(2) as ComarkNode[], cites, links)
    if (cites.size > 0 || links.size > 0) out[id] = { cites: [...cites], links: [...links] }
  }
  return out
}

/** The reference nodes below a node, as the edges they name. */
function collectReferences(nodes: ComarkNode[], cites: Set<string>, links: Set<string>): void {
  for (const node of nodes) {
    if (typeof node === 'string') continue
    const [tag, props, ...children] = node
    if (tag === CITATION_TAG) {
      const target = citeTarget(props ?? {})
      if (target?.kind === 'doc') addEdges(cites, target.nid, target.block)
    }
    else if (tag === DOC_LINK_TAG) {
      const target = docLinkTarget(props ?? {})
      if (target) addEdges(links, target.nid, target.block)
    }
    collectReferences(children, cites, links)
  }
}

/** One reference as the edges it is looked up by: the page, and the block. */
function addEdges(out: Set<string>, nid: number, block: string | null): void {
  out.add(String(nid))
  if (block) out.add(`${nid}#${block}`)
}

/** The chips below a node, once per number, in document order. */
function collectCitations(nodes: ComarkNode[], out: Map<string, CitationSource>): void {
  for (const node of nodes) {
    if (typeof node === 'string') continue
    const [tag, props, ...children] = node
    // A chip, by the number it carries — the authored node it was rendered
    // from names a source instead, and is gone by this point.
    if (tag === CITATION_TAG && typeof props?.n === 'string') {
      const source = props as unknown as CitationSource
      if (!out.has(source.n)) out.set(source.n, source)
      continue
    }
    collectCitations(children, out)
  }
}

/** The words below a node. */
export function collectText(nodes: ComarkNode[]): string {
  let out = ''
  for (const node of nodes) {
    out += typeof node === 'string' ? node : collectText(node.slice(2) as ComarkNode[])
  }
  return out
}

/**
 * The props a resolved image renders with: per-embed alt overrides the
 * media entity's own; an unresolvable UUID keeps `media`/`alt` only and
 * the renderer shows a hole (no src).
 */
function imageProps(props: ComarkProps, media: Record<string, ResolvedMedia>): ComarkProps {
  const item = typeof props.media === 'string' ? media[props.media] : undefined
  if (!item) return props
  return {
    ...props,
    src: item.url,
    alt: (typeof props.alt === 'string' && props.alt !== '') ? props.alt : item.alt,
    width: item.width ?? undefined,
    height: item.height ?? undefined,
  }
}

/** Attribute names HTML allows. Anything else cannot be an attribute. */
const ATTR_NAME = /^[A-Za-z][A-Za-z0-9:_.-]*$/

const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'srcset', 'formaction', 'action', 'poster', 'data'])

/** Schemes that execute or smuggle markup. Images are the one data: exception. */
const UNSAFE_SCHEME = /^(javascript|vbscript|data):/i

/** C0 and space: the URL parser ignores them, the scheme checks must not. */
const CONTROLS = /[\u0000-\u0020]/g

/**
 * The `data:` URIs a document may carry: an image of any type, its bytes inert
 * (a browser runs no script inside an `<img>`). Strip C0 and space first: the
 * URL parser ignores them, so `da\nta:image/…` would read as `data:` in the DOM.
 */
function isDataImage(url: string): boolean {
  return /^data:image\//i.test(url.replace(CONTROLS, ''))
}

/**
 * The floor under the format's list: nothing here may script the page. A
 * `:`-name carries an expression the renderer evaluates and `as` names the
 * component a node mounts as, so neither is a document's to write. C0 and space
 * go before the scheme check — the URL parser ignores them, so `java\nscript:` runs.
 */
function isSafeAttr(key: string, value: unknown): boolean {
  if (!ATTR_NAME.test(key) || /^on/i.test(key) || key === 'as') return false
  if (!URL_ATTRS.has(key.toLowerCase())) return true
  const url = String(value).replace(CONTROLS, '')
  return !UNSAFE_SCHEME.test(url) || isDataImage(url)
}

/** The rule for one name: an exact entry, else the longest `prefix*` glob. */
function rule(rules: Record<string, AttrRule>, name: string): AttrRule | undefined {
  if (Object.hasOwn(rules, name)) return rules[name]
  let match: AttrRule | undefined
  let width = 0
  for (const [key, value] of Object.entries(rules)) {
    const prefix = key.length > 1 && key.endsWith('*') ? key.slice(0, -1) : ''
    if (prefix && prefix.length >= width && name.startsWith(prefix)) [match, width] = [value, prefix.length]
  }
  return match
}

/**
 * What the format lists for this tag, under what it lists for every tag.
 * `true` is "any attribute", which leaves no rules to hold a name to.
 */
function tagRules(tag: string, allowed?: AllowedHtml): Record<string, AttrRule> | undefined {
  if (!allowed) return undefined
  const own = allowed[tag]
  const global = allowed['*']
  if (own === true || global === true) return undefined
  return { ...own, ...global }
}

/**
 * The attributes that may reach the DOM, held to the built-in checks either
 * way. A value-restricted attribute keeps the whitespace-separated values the
 * list carries and drops when none are left, as `filter_html` reads it.
 */
function allowedProps(tag: string, props: ComarkProps, allowed?: AllowedHtml): ComarkProps {
  const rules = tagRules(tag, allowed)
  const out: ComarkProps = {}
  for (const [key, value] of Object.entries(props)) {
    if (!isSafeAttr(key, value)) continue
    if (!rules) {
      out[key] = value
      continue
    }
    const allowedValues = rule(rules, key)
    if (allowedValues === undefined) continue
    if (allowedValues === true) {
      out[key] = value
      continue
    }
    const kept = String(value).split(/\s+/).filter(one => rule(allowedValues, one) !== undefined)
    if (kept.length > 0) out[key] = kept.join(' ')
  }
  return out
}

/**
 * comark renders a task-list checkbox through `:checked`/`:disabled` bindings.
 * Written as plain attributes here, so the two states the parser expresses
 * survive the filter while no expression ever reaches the renderer.
 */
function plainBindings(tag: string, props: ComarkProps): ComarkProps {
  if (tag !== 'input' || props.type !== 'checkbox') return props
  const { ':checked': checked, ':disabled': disabled, ...rest } = props
  return {
    ...rest,
    ...(checked === 'true' ? { checked: true } : {}),
    ...(disabled === 'true' ? { disabled: true } : {}),
  }
}
