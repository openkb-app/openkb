/**
 * The `# <title>` line a stored body carries first — the title field's
 * spelling in markdown, not the editor document's.
 *
 * It is split off at the Drupal read boundary and written again by whoever
 * writes the body, so the editor document never carries it and a save that
 * changed nothing else leaves the stored bytes alone.
 */
import { mintBlockId, type IdSource } from '#shared/page-blocks'

/** The heading line plus the blank lines under it, so the remainder starts at
 *  the body's first block. Indented lines are body (a code block), not padding. */
const TITLE_HEADING = /^#[ \t][^\n]*\n?(?:[ \t]*\n)*/

/** The heading line alone — what a write respells. */
const TITLE_HEADING_LINE = /^#[ \t][^\n]*/

/** The blank lines a serialized document can open with — padding, not content. */
const LEADING_BLANK_LINES = /^(?:[ \t]*\n)+/

/** The heading's own trailing block id, on the bodies that carry one. */
const BLOCK_ID = /\{#[\w-]+\}[ \t]*$/

export interface SplitBody {
  /** The heading and its trailing blank lines, or '' when there is none. */
  titleHeading: string
  /** Everything after it — the document. */
  body: string
}

export function splitTitleHeading(stored: string): SplitBody {
  const titleHeading = TITLE_HEADING.exec(stored)?.[0] ?? ''
  return { titleHeading, body: stored.slice(titleHeading.length) }
}

/**
 * The heading line spelling the current title, block id and all — the line
 * alone, so the gap under it is the caller's to set.
 *
 * A body that carries no heading gets one, so the split above can stay a single
 * regex on both sides of the wire: the first line is the title heading, and a
 * heading the author writes is always below it.
 *
 * A heading that carries no block id gets one minted: it is the lead section's
 * block, which every citation of that section anchors on (openkb_search).
 */
function spellTitleHeading(titleHeading: string, title: unknown, source?: IdSource): string {
  const line = TITLE_HEADING_LINE.exec(titleHeading)?.[0].trimEnd() ?? ''
  if (typeof title !== 'string' || title === '') return line
  const id = BLOCK_ID.exec(line)?.[0].trimEnd() ?? `{#${mintBlockId(source)}}`
  return `# ${title} ${id}`
}

/** One final newline — the file's terminator, which the serializer never emits. */
function terminated(body: string): string {
  return body === '' ? '' : body.replace(/\n*$/, '\n')
}

/**
 * The stored bytes for a document: title heading, blank line, body, one final
 * newline.
 *
 * The heading is the title field's spelling, so every write respells it and a
 * rename needs nothing of its own. Four shapes are normalised rather than
 * kept: a body carrying no heading gains one, a heading carrying no block id
 * gains one, the gap under the heading is exactly one blank line, and the text
 * ends in exactly one newline.
 */
export function storedBody(titleHeading: string, title: unknown, body: string, source?: IdSource): string {
  const heading = spellTitleHeading(titleHeading, title, source)
  if (heading === '') return terminated(body)
  return `${heading}\n\n${terminated(body.replace(LEADING_BLANK_LINES, ''))}`
}
