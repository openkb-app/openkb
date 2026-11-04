/**
 * The places comark's renderer writes markdown its own parser reads back as
 * something else. Everything else renders with comark's handlers.
 */
import type { State } from 'comark/render'
import type { ComarkNode } from '#shared/utils/comark-tree'
import { textContentOf } from './pm-mapper'
import type { ComarkElement } from './pm-mapper'

type Handler = (node: ComarkElement, state: State, parent?: ComarkElement) => string | Promise<string>

/** A `{` the writer escapes; `escapeBareBraces` splits it out of the text. */
export const BARE_BRACE_TAG = 'okb-bare-brace'

/** A `{` comark's renderer leaves bare: neither part of `{{` or `${`, nor what it escapes itself. */
const BARE_BRACE = /(?<![{$])\{(?!\{|[ \t]{0,3}[.#:a-zA-Z_])/

/** Elements whose text comark writes verbatim, not as markdown text. */
const VERBATIM_TAGS = new Set(['code', 'pre'])

/** What the autolink form `<…>` reads back as a link: a scheme, then no space or `<>`. */
const AUTOLINK = /^[a-z][a-z0-9+.-]{1,31}:[^\s<>]*$/i

/**
 * Escapes what comark's renderer leaves bare where its parser reads syntax:
 * - text: a bare `{` opens attributes up to the line's end (`JSON {"a": 1}` reads back as `JSON`);
 * - destination: `)`, whitespace or `<>` end the link (`[t](/a)b)` reads back as href `/a`);
 * - alt: `]` ends the image (`![a]b](/i.png)` reads back as text).
 */
export function escapeWhatComarkMisses(value: string, context: 'text' | 'destination' | 'alt'): string {
  switch (context) {
    case 'text':
      return value.replace(new RegExp(BARE_BRACE, 'g'), '\\{')
    case 'destination':
      return /[\s()<>\\]/.test(value) ? `<${value.replace(/[<>\\]/g, '\\$&')}>` : value
    case 'alt':
      return value.replace(/[\\[\]]/g, '\\$&')
  }
}

/** Splits each bare `{` out of the tree's text into a `BARE_BRACE_TAG` element, so comark's text escaping runs on the rest unchanged. */
export function escapeBareBraces(nodes: ComarkNode[]): ComarkNode[] {
  return nodes.flatMap((node): ComarkNode[] => {
    if (typeof node !== 'string') {
      const [tag, props, ...children] = node as ComarkElement
      return [VERBATIM_TAGS.has(tag) ? node : [tag, props, ...escapeBareBraces(children)] as ComarkNode]
    }
    // split() puts each captured brace at an odd index.
    return node.split(new RegExp(`(${BARE_BRACE.source})`))
      .map((part, index): ComarkNode => index % 2 === 1 ? [BARE_BRACE_TAG, {}, part] : part)
      .filter(part => part !== '')
  })
}

/** Writes a link with comark's handler; a link whose text is its href is written `<href>` only where that reads back as a link (`</foo>` is an HTML tag). */
async function renderLink(node: ComarkElement, state: State, parent?: ComarkElement): Promise<string> {
  const [tag, { href = '', ...props }, ...children] = node as [string, { href?: string }, ...ComarkNode[]]
  const markdown: string = await state.handlers.a!([tag, { href: escapeWhatComarkMisses(String(href), 'destination'), ...props }, ...children] as never, state, parent as never)
  return markdown === `<${href}>` && !AUTOLINK.test(String(href)) ? `[${href}](${href})` : markdown
}

/** Writes an image with comark's handler, its alt and src escaped. */
function renderImage(node: ComarkElement, state: State): string | Promise<string> {
  const [tag, { src = '', alt = '', ...props }] = node as [string, { src?: string, alt?: string }]
  return state.handlers.img!([tag, { src: escapeWhatComarkMisses(String(src), 'destination'), alt: escapeWhatComarkMisses(String(alt), 'alt'), ...props }] as never, state)
}

/**
 * Writes inline code holding a backtick in a fence one backtick longer than
 * its longest run, padded where it starts or ends on one: comark's `` fence
 * reads `` `code` `` back as `code` and a lone backtick as an empty code block.
 */
function renderInlineCode(node: ComarkElement, state: State, parent?: ComarkElement): string | Promise<string> {
  const code = textContentOf(node.slice(2) as ComarkNode[])
  if (!code.includes('`')) return state.handlers.code!(node as never, state, parent as never)
  const fence = '`'.repeat(Math.max(...(code.match(/`+/g) ?? []).map(run => run.length)) + 1)
  const pad = /^[` ]|[` ]$/.test(code) && code.trim() !== '' ? ' ' : ''
  return `${fence}${pad}${code}${pad}${fence}`
}

const PUNCTUATION = /[\p{P}\p{S}]/u
const WHITESPACE = /\s/u

/** Inline containers: a line edge there counts as whitespace for flanking. */
const INLINE_CONTAINERS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th'])

const DELIMITER_OF: Record<string, string> = { strong: '*', em: '*', del: '~' }

/** The character next to `node` on one side, as the parser sees it; a line edge or nested mark counts as whitespace or punctuation. */
function neighborCharacter(node: ComarkElement, parent: ComarkElement | undefined, side: -1 | 1): string {
  const siblings = parent?.slice(2) as ComarkNode[] | undefined
  const sibling = siblings?.[siblings.indexOf(node) + side]
  if (sibling === undefined) return parent && !INLINE_CONTAINERS.has(parent[0]) ? '*' : ' '
  if (typeof sibling !== 'string') return sibling[0] === 'br' ? '\n' : '*'
  const chars = Array.from(sibling)
  return (side === 1 ? chars[0] : chars.at(-1)) ?? ' '
}

/** Counts the marks with this delimiter character a mark element starts (side -1) or ends (side 1) on, itself included. */
function countEdgeMarks(node: ComarkNode | undefined, char: string, side: -1 | 1): number {
  if (!Array.isArray(node) || DELIMITER_OF[node[0]] !== char) return 0
  const children = node.slice(2) as ComarkNode[]
  return 1 + countEdgeMarks(side === 1 ? children.at(-1) : children[0], char, side)
}

/** Whether a delimiter run sits between `outer` and `inner` so that it opens (or closes) emphasis. */
function delimiterRunFlanks(outer: string, inner: string): boolean {
  return !WHITESPACE.test(inner) && (!PUNCTUATION.test(inner) || WHITESPACE.test(outer) || PUNCTUATION.test(outer))
}

/**
 * Writes bold, italic or strike with comark's handler, or as its HTML tag
 * where the delimiters would not open and close emphasis: `a**(b)**` and
 * `**a*b****c*` read back with literal `*`. Of two marks whose delimiters
 * join into one run, the later takes the tag, so a paragraph never opens on one.
 */
function renderEmphasisMark(tag: 'strong' | 'em' | 'del'): Handler {
  const delimiter = tag === 'del' ? '~~' : tag === 'strong' ? '**' : '*'
  const char = delimiter[0]!
  return async (node, state, parent) => {
    const markdown: string = await state.handlers[tag]!(node as never, state, parent as never)
    const core = markdown.slice(delimiter.length, -delimiter.length)
    if (!core) return ''
    // A nested mark's delimiters join this one's run: flanking looks past them.
    const chars = Array.from(core.replace(char === '~' ? /^~+|~+$/g : /^\*+|\*+$/g, '') || core)
    const siblings = parent?.slice(2) as ComarkNode[] | undefined
    const joinedRun = countEdgeMarks(siblings?.[siblings.indexOf(node) - 1], char, 1)
    const flanks = delimiterRunFlanks(neighborCharacter(node, parent, -1), chars[0]!)
      && delimiterRunFlanks(neighborCharacter(node, parent, 1), chars.at(-1)!)
      && !(joinedRun > 0 && joinedRun + countEdgeMarks(node, char, -1) > 2)
    return flanks ? markdown : `<${tag}>${core}</${tag}>`
  }
}

/**
 * Writes a textblock (paragraph, heading, table) with comark's handler in
 * inline context, so a component alone in it is written `:name[…]{…}` on its
 * line, not as a block fence: comark decides by text siblings only.
 */
function renderInInlineContext(tag: string): Handler {
  return async (node, state, parent) => {
    const revert = state.applyContext({ inline: true })
    try {
      return await state.handlers[tag]!(node as never, state, parent as never)
    }
    finally {
      state.applyContext(revert)
    }
  }
}

export const renderHandlers: Record<string, Handler> = {
  ...Object.fromEntries(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table'].map(tag => [tag, renderInInlineContext(tag)])),
  /** Writes a bare `{` the mapper marked, escaped, so it opens no attribute list. */
  [BARE_BRACE_TAG]: () => escapeWhatComarkMisses('{', 'text'),
  a: renderLink,
  img: renderImage,
  code: renderInlineCode,
  strong: renderEmphasisMark('strong'),
  em: renderEmphasisMark('em'),
  del: renderEmphasisMark('del'),
}
