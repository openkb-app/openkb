/**
 * The entity boundary between stored comark and whoever reads it as source.
 *
 * Every surface that serves page content — the tools, the `.md` lanes —
 * hands over plain characters and takes plain characters back; the stored body
 * keeps comark's spelling.
 * See docs/adr/0014-stored-comark-is-spelled-as-comark-writes-it.md.
 */
import { decodeHtmlEntities, encodeHtmlEntities } from '@tiptap/core'

/**
 * Stored comark → what a reader of the source sees.
 *
 * A stored body may carry entities; comark reads them as these characters.
 */
export function decodePageEntities(markdown: string): string {
  return mapOutsideCode(markdown, text => text.split(ESCAPED_AMP_RE).map(decodeHtmlEntities).join('&'))
}

/**
 * What a model writes → markdown that parses to the document it wrote.
 *
 * Only the two spellings the parser would read as markup need it; every other
 * `&`, `<` and `>` is text to the parser already, and the next editor save
 * spells it comark's way. The mark tags the editor stores stay markup, so a
 * block written back as it was read stores the same bytes.
 */
export function encodePageEntities(markdown: string): string {
  return mapOutsideCode(markdown, encodeMarkupStarts)
}

/**
 * The tags comark's renderer writes for marks: underline always, the others
 * where their delimiters cannot open or close.
 */
const STORED_MARK_TAGS = ['u', 'strong', 'em', 'del']

/** Not preceded by an odd run of backslashes: a backslash-escaped `&` or `<` is text. */
const NOT_ESCAPED = '(?<!(?:^|[^\\\\])(?:\\\\\\\\)*\\\\)'

/** A backslash-escaped `&`: the tiptap decoder runs only between them. */
const ESCAPED_AMP_RE = /(?<=(?:^|[^\\])(?:\\\\)*\\)&/g

/** An unescaped `&` opening an entity reference or `<` opening a tag other than a stored mark tag. */
const MARKUP_START_RE = new RegExp(
  `${NOT_ESCAPED}&(?=#[0-9]{1,7};|#[xX][0-9a-fA-F]{1,6};|[A-Za-z][A-Za-z0-9]{1,31};)`
  + `|${NOT_ESCAPED}<(?!/?(?:${STORED_MARK_TAGS.join('|')})>)(?=[!/?]|[A-Za-z][A-Za-z0-9-]*[\\s/>])`,
  'g',
)

function encodeMarkupStarts(text: string): string {
  return text.replace(MARKUP_START_RE, char => encodeHtmlEntities(char))
}

/** Opens or closes a fenced code block. */
export const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/

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
