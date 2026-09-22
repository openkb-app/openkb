/**
 * A citation: the source a block was derived from, written in the body.
 *
 * Stored as the comark inline component `:citation{nid="42" block="b-4f2a"
 * v="9c1f0a…"}` — one block of another page, and the version of that block
 * the citation was made against — or `:citation{url="https://…"}` for a source
 * outside the knowledge base. It is `:doc[…]`'s sibling
 * (#shared/utils/doc-links.ts); the difference is the label, which a citation
 * does not carry: the number a reader sees is assigned where the page is
 * rendered.
 *
 * The version is the short content hash of the cited block's canonical
 * markdown (server/utils/block-versions.ts). Comparing it with the block's
 * current version on read is what says whether a citation is still about the
 * text it was made against.
 */

/**
 * The comark component name a citation is stored as, authored and resolved
 * alike: the body writes `:citation{nid …}`, the tree pass renders it as the
 * numbered chip the chat's answers already carry (`CustomCitation`). What a
 * node carries says which it is — an authored one names a source, a chip a
 * number — and the two never meet in one tree.
 */
export const CITATION_TAG = 'citation'

/** What one citation points at. */
export type CiteTarget =
  | { kind: 'doc', nid: number, block: string | null, v: string | null }
  | { kind: 'url', url: string }

/**
 * How a citation stands to the source it names.
 *
 * - `ok` — the source reads as it did when it was cited.
 * - `stale` — the cited block's text has moved since; re-read it.
 * - `dangling` — the citation names nothing this reader can reach: the block
 *   is gone from the page, or the page itself does not resolve.
 */
export type CiteState = 'ok' | 'stale' | 'dangling'

/** Schemes a citation may address the world outside the knowledge base with. */
const EXTERNAL_SCHEME = /^https?:\/\//i

/**
 * The target a `:citation` component's props name, or null when they name none.
 *
 * `url` wins over `nid`: a component carrying both names two sources, and the
 * external one is the one that needs no resolution to be a link.
 */
export function citeTarget(props: Record<string, unknown>): CiteTarget | null {
  const url = typeof props.url === 'string' ? props.url.trim() : ''
  if (url !== '') return EXTERNAL_SCHEME.test(url) ? { kind: 'url', url } : null
  const nid = Number(props.nid)
  if (!Number.isInteger(nid) || nid <= 0) return null
  const block = typeof props.block === 'string' && props.block !== '' ? props.block : null
  const v = typeof props.v === 'string' && props.v !== '' ? props.v : null
  return { kind: 'doc', nid, block, v: block ? v : null }
}

/**
 * What makes two citations one source, for numbering and for the per-block
 * list. The version is not part of it: two citations of one block are one
 * source however far apart they were made.
 */
export function citeKey(target: CiteTarget): string {
  return target.kind === 'url' ? `url:${target.url}` : `doc:${target.nid}#${target.block ?? ''}`
}

/**
 * How a citation stands, given what the cited page currently holds.
 *
 * `versions` is the cited page's block id → version map, or null when the page
 * did not resolve for this reader — which covers an unreadable page and a
 * deleted one alike, so both read as dangling. A citation carrying no version
 * has nothing to compare and is never stale.
 */
export function citeState(
  target: CiteTarget,
  versions: Record<string, string> | null,
): CiteState {
  if (target.kind === 'url') return 'ok'
  if (!versions) return 'dangling'
  if (!target.block) return 'ok'
  const current = versions[target.block]
  if (current === undefined) return 'dangling'
  return target.v !== null && current !== target.v ? 'stale' : 'ok'
}

/** What the chip says about a citation beyond its number, per state. */
export const CITE_STATE_NOTE: Record<Exclude<CiteState, 'ok'>, string> = {
  stale: 'the source has changed since it was cited',
  dangling: 'the source is no longer there',
}

/** The glyph each state carries, so it never rides colour alone. */
export const CITE_STATE_GLYPH: Record<Exclude<CiteState, 'ok'>, string> = {
  stale: '!',
  dangling: '?',
}

/** What an external citation is called when nothing else names it. */
export function citeUrlTitle(url: string): string {
  try {
    return new URL(url).host
  }
  catch {
    return url
  }
}
