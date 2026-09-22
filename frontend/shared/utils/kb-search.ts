/**
 * How one search row reads: a page, opened on the section that matched best.
 *
 * The chunk index answers sections; the row shows a page. These are the three
 * decisions that turn one into the other, kept out of the page so they can be
 * read and tested on their own.
 */

/** One matching section of a page. */
export interface SearchSection {
  blockId: string
  /** The headings the section sits under, outermost first. */
  headingPath: string[]
  /** Plain text: a section found by meaning alone has no term to mark. */
  excerpt: string
  /**
   * The passages the words of the query matched in, each match marked.
   *
   * Empty where the section was found by meaning alone. A fragment is page
   * text apart from the mark characters, so it is split into parts and
   * interpolated, never set as HTML.
   */
  highlights: string[]
  score: number
  /** The page path with the section's anchor. */
  path: string
}

/** One row: a page, and every section of it the query matched. */
export interface SearchPage {
  id: string
  score: number
  title: string
  path: string
  space: string
  /** The page's document type, by machine name. */
  type: string
  /** The tags the page carries, by name. */
  tags: string[]
  /** When the page was last changed, as a Unix timestamp. */
  changed: number
  /** Best first. Empty where nothing was matched — the empty query's listing. */
  sections: SearchSection[]
}

/** What a page search answers. */
export interface PageSearchResponse {
  query: string
  /** The zero-based window. */
  page: number
  pageSize: number
  /**
   * How many pages there are, where that is known.
   *
   * The listing counts; a search does not — the collapse runs after the chunk
   * fetch, so only the fetched window is ever known.
   */
  total: number | null
  /** Whether a further window follows this one. */
  hasMore: boolean
  pages: SearchPage[]
  /** Why nothing was searched, where the query itself was refused. */
  refused?: string
}

/**
 * Where the row's title links: the section that matched best, on its block.
 *
 * A page with no matching section — the empty query's listing — links to
 * itself.
 */
export function rowLink(page: SearchPage): string {
  return page.sections[0]?.path || page.path
}

/** One run of an excerpt, marked where the query's words matched it. */
export interface ExcerptPart {
  text: string
  marked: boolean
}

/** How many matched passages an excerpt shows at once. */
const FRAGMENTS_SHOWN = 2

/** What joins two passages cut from different places in the section. */
const FRAGMENT_JOIN = ' … '

/**
 * What the index wraps a matched word in.
 *
 * Private-use characters, so no page text can carry a pair of them and pass
 * itself off as a mark. They have to be printable: the highlighter trims a
 * fragment's edges, and a control character there goes with the whitespace.
 */
export const MARK_OPEN = '\uE000'
export const MARK_CLOSE = '\uE001'

/** One marked passage: an opening character, text, a closing character. */
export const MARKED = /\uE000([^\uE000\uE001]*)\uE001/g

/** A mark character with no partner — page text, and never a mark. */
export const STRAY_MARK = /[\uE000\uE001]/g

/** The excerpt under the row's title: the best section's, marked. */
export function rowExcerptParts(page: SearchPage): ExcerptPart[] {
  const best = page.sections[0]
  return best ? excerptParts(best) : []
}

/**
 * The excerpt to show, split into plain and marked runs.
 *
 * A section the words of the query matched shows those passages with the
 * words marked; one found by meaning alone shows its own opening text.
 */
export function excerptParts(section: SearchSection): ExcerptPart[] {
  if (section.highlights.length === 0) {
    return section.excerpt ? [{ text: section.excerpt, marked: false }] : []
  }
  return markedParts(section.highlights.slice(0, FRAGMENTS_SHOWN).join(FRAGMENT_JOIN))
}

/**
 * One marked fragment, split into plain and marked runs.
 *
 * Everything but the mark characters is page text, so a caller interpolates
 * the runs and never sets the fragment as HTML.
 */
export function markedParts(fragment: string): ExcerptPart[] {
  const parts: ExcerptPart[] = []
  const plain = (text: string) => text.replace(STRAY_MARK, '')
  let at = 0
  for (const match of fragment.matchAll(MARKED)) {
    const before = plain(fragment.slice(at, match.index))
    if (before) parts.push({ text: before, marked: false })
    if (match[1]) parts.push({ text: match[1], marked: true })
    at = match.index + match[0].length
  }
  const rest = plain(fragment.slice(at))
  if (rest) parts.push({ text: rest, marked: false })
  return parts
}

/**
 * The page's other matching sections, as sub-links.
 *
 * The best one is the excerpt above, so it is not listed again.
 */
export function subSections(page: SearchPage): SearchSection[] {
  return page.sections.slice(1)
}

/**
 * How a sub-link names its section: its own heading.
 *
 * The chunker opens a lead section's path on the page's own `<h1>`, so that
 * path is the row's title. Naming the section after it would repeat the title
 * one line above, so a lead is named for what it is.
 */
export function sectionLabel(section: SearchSection, page: SearchPage): string {
  const heading = section.headingPath.at(-1)
  if (!heading || (section.headingPath.length === 1 && heading === page.title)) return 'Introduction'
  return heading
}

/** The line above the sub-links, counting the sections listed under it. */
export function sectionsLabel(page: SearchPage): string {
  const count = subSections(page).length
  return count === 1 ? '1 more matching section' : `${count} more matching sections`
}

/** The day a row was last changed. `changed` is Drupal's seconds, not JS's ms. */
export function changedOn(page: SearchPage): string {
  if (!page.changed) return ''
  return new Date(page.changed * 1000)
    .toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * The windows the Updated filter offers, and how far back each one reaches.
 *
 * A closed set on both sides of the wire: the chip offers these, the route
 * refuses anything else, and `openkb_search`'s SearchController holds the
 * same spans for the semantic arm.
 */
export const UPDATED_RANGES: Record<string, { label: string, seconds: number }> = {
  week: { label: 'Past week', seconds: 7 * 86400 },
  month: { label: 'Past month', seconds: 30 * 86400 },
  year: { label: 'Past year', seconds: 365 * 86400 },
}

/** Whether a value names one of them; '' narrows nothing and is not one. */
export function isUpdatedRange(value: string): boolean {
  return value !== '' && Object.hasOwn(UPDATED_RANGES, value)
}

/** The timestamp a range reaches back to, in Drupal's seconds. */
export function changedSince(range: string, now: number = Date.now()): number | undefined {
  const span = UPDATED_RANGES[range]?.seconds
  return span === undefined ? undefined : Math.floor(now / 1000) - span
}
