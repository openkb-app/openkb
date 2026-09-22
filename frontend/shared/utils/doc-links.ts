/**
 * A link from one page to another: the stored form, and the address it
 * resolves to.
 *
 * Stored as the comark inline component `:doc[Label]{nid="42"}`, optionally
 * naming one block of the target (`block="b-4f2a"`). The nid is the identity
 * and the label the words, so the link survives a rename or a re-alias. The
 * label is also the whole rendering for a reader the target does not resolve
 * for (`server/utils/doc-links.ts`).
 */

/** The comark component name a document link is stored as. */
export const DOC_LINK_TAG = 'doc'

/** Where one link points: a page, and at most one block inside it. */
export interface DocLinkTarget {
  nid: number
  block: string | null
}

/** What resolving a target answers when the reader may see it. */
export interface ResolvedDoc {
  title: string
  path: string
}

/**
 * The target a `:doc` component's props name, or null when they name none.
 *
 * Props arrive as strings whichever quoting style comark accepted, so the nid
 * is validated here. A component with no usable nid is not a link; callers
 * render it as prose.
 */
export function docLinkTarget(props: Record<string, unknown>): DocLinkTarget | null {
  const nid = Number(props.nid)
  if (!Number.isInteger(nid) || nid <= 0) return null
  const block = typeof props.block === 'string' && props.block !== '' ? props.block : null
  return { nid, block }
}

/**
 * The address one link resolves to.
 *
 * With a path, meaning the reader may see the target, that is the target's own
 * alias. Without one it is `/node/<nid>`, which Drupal answers 404 for both an
 * unreadable target (`HideInvisibleSpaceSubscriber`) and a deleted one, so the
 * two cannot be told apart by following the link.
 */
export function docLinkHref(nid: number, path: string | null, block: string | null): string {
  const base = path && path !== '' ? path : `/node/${nid}`
  return block ? `${base}#${block}` : base
}
