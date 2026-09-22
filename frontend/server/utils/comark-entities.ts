/**
 * The entity boundary between stored comark and whoever reads it as source.
 *
 * Every surface that serves page content — the tools, the `.md` lanes —
 * hands over plain characters and takes plain characters back; the stored body
 * keeps the serializer's spelling.
 * See docs/adr/0014-wire-format-keeps-html-entities.md.
 */
import { decodeHtmlEntities, encodeHtmlEntities } from '@tiptap/core'

/**
 * Stored comark → what a reader of the source sees.
 *
 * The codec is the serializer's own, so a decode undoes what a write encoded.
 */
export function decodePageEntities(markdown: string): string {
  return mapOutsideCode(markdown, decodeHtmlEntities)
}

/**
 * What a model writes → markdown that parses to the document it wrote.
 *
 * Only the two spellings the parser would read as markup need it; every other
 * `&`, `<` and `>` is text to the parser already, and the next editor save
 * spells it the serializer's way.
 */
export function encodePageEntities(markdown: string): string {
  return mapOutsideCode(markdown, encodeMarkupStarts)
}

/** An `&` opening an entity reference, a `<` opening a tag. */
const MARKUP_START_RE
  = /&(?=#[0-9]{1,7};|#[xX][0-9a-fA-F]{1,6};|[A-Za-z][A-Za-z0-9]{1,31};)|<(?=[!/?]|[A-Za-z][A-Za-z0-9-]*[\s/>])/g

function encodeMarkupStarts(text: string): string {
  return text.replace(MARKUP_START_RE, char => encodeHtmlEntities(char))
}

/** Opens or closes a fenced code block. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/

/** Applies `map` to everything outside fenced code blocks and code spans. */
export function mapOutsideCode(markdown: string, map: (text: string) => string): string {
  const out: string[] = []
  let prose: string[] = []
  let fence: string | undefined
  const flush = (): void => {
    if (prose.length > 0) out.push(mapOutsideCodeSpans(prose.join('\n'), map))
    prose = []
  }
  for (const line of markdown.split('\n')) {
    const marker = FENCE_RE.exec(line)?.[1]
    if (fence !== undefined) {
      out.push(line)
      if (marker?.[0] === fence[0] && marker.length >= fence.length) fence = undefined
      continue
    }
    if (marker !== undefined) {
      flush()
      out.push(line)
      fence = marker
      continue
    }
    prose.push(line)
  }
  flush()
  return out.join('\n')
}

/** Applies `map` outside code spans; a run that never closes is text. */
function mapOutsideCodeSpans(text: string, map: (text: string) => string): string {
  const runs = /`+/g
  let out = ''
  let at = 0
  let run: RegExpExecArray | null
  while ((run = runs.exec(text)) !== null) {
    const closed = closingRun(text, runs.lastIndex, run[0].length)
    if (closed === undefined) continue
    out += map(text.slice(at, run.index)) + text.slice(run.index, closed)
    at = closed
    runs.lastIndex = closed
  }
  return out + map(text.slice(at))
}

/** Where the backtick run of `length` closing the span at `from` ends. */
function closingRun(text: string, from: number, length: number): number | undefined {
  const runs = /`+/g
  runs.lastIndex = from
  let run: RegExpExecArray | null
  while ((run = runs.exec(text)) !== null) {
    if (run[0].length === length) return runs.lastIndex
  }
  return undefined
}
