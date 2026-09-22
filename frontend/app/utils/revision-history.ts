
/**
 * One revision, exactly as the CE route serves it.
 *
 * Everything but `vid` and `created` is optional because Drupal omits an
 * attribute it has nothing to put in — a gone author, a save with no message.
 * Optional means "this revision does not have one"; the row renders nothing.
 */
export interface RevisionProps {
  vid: number
  /** ISO 8601, UTC — rendered in the reader's own zone. */
  created: string
  author?: string | null
  /** The author's account, for the link to their profile. */
  authorUid?: number | null
  log?: string | null
  state?: string | null
  /** The newest revision: what the editing surfaces open. */
  current?: boolean
  /** The revision being served to readers. */
  published?: boolean
}

/** A marker on a revision row, in the order returned. */
export interface RevisionMarker {
  label: string
  color: 'success' | 'info'
  icon: string
}

/**
 * What is special about this revision, most-significant first.
 *
 * The reason a history is worth reading is that the two marks land on different
 * rows: **Live** is what the world is served, **Working copy** is the newest
 * one, and a draft on top of a published version has one of each. Both on one
 * row is the ordinary case of nothing pending — two facts that coincide, and
 * the next save separates them again.
 *
 * The moderation state is not a marker: every row has one, and a badge on every
 * row marks nothing.
 */
export function revisionMarkers(revision: RevisionProps): RevisionMarker[] {
  const markers: RevisionMarker[] = []
  if (revision.published) {
    markers.push({ label: 'Live', color: 'success', icon: 'i-lucide-globe' })
  }
  if (revision.current) {
    markers.push({ label: 'Working copy', color: 'info', icon: 'i-lucide-pencil-line' })
  }
  return markers
}

/**
 * The line under the heading when the list is not the whole history.
 *
 * Null when it is — "showing 3 of 3" makes the reader check a number that was
 * never in doubt. Past the window the sentence has to carry the total, because
 * the rows can no longer be counted for it.
 */
export function historyScope(shown: number, total: number): string | null {
  if (total <= shown) return null
  return `Showing the ${shown} most recent of ${total} revisions.`
}
