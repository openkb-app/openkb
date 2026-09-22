/**
 * Page metadata as the CE-API delivers it, and the derivations the read page
 * renders from it.
 *
 * `custom_elements.entity_ce_display.node.kb_page.full` names each
 * frontmatter prop after its frontmatter key — `type`, `summary`, `owner`,
 * `contributors`, `tags` — and renders every reference with `uuid` and a raw
 * `label`, so single and multi-value references have the one shape.
 *
 * Everything here is pure so the read page has no metadata branching of its own
 * and the shapes stay unit-testable without a Drupal round-trip.
 */

/** A referenced entity, as the CE display projects it. */
export interface CeEntityReference {
  uuid?: string
  label?: string
}

/** Human labels for `field_type`'s allowed values. */
const DOC_TYPE_LABELS: Record<string, string> = {
  article: 'Article',
  adr: 'ADR',
  guide: 'Guide',
  runbook: 'Runbook',
}

/**
 * Label for a `field_type` value. An unmapped value renders capitalised rather
 * than as a blank pill — the allowed-values list grows on the Drupal side and
 * the frontend must not need a deploy to stay honest.
 */
export function docTypeLabel(value: string | undefined | null): string | null {
  if (!value) return null
  return DOC_TYPE_LABELS[value] ?? value.charAt(0).toUpperCase() + value.slice(1)
}

/**
 * Labels of a reference prop, in field order. A single-value field ships one
 * object rather than a list, and an item whose entity the session may not view
 * carries no label — dropped, because a blank chip claims nothing useful.
 */
export function referenceLabels(
  value: CeEntityReference[] | CeEntityReference | undefined | null,
): string[] {
  if (value === null || value === undefined) return []
  return (Array.isArray(value) ? value : [value])
    .map(item => item?.label?.trim() ?? '')
    .filter(label => label.length > 0)
}

/** Epoch milliseconds from a CE `changed` prop (Drupal ships epoch seconds). */
export function changedToMs(value: string | number | undefined | null): number | null {
  const seconds = typeof value === 'string' ? Number(value) : value
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null
  return seconds * 1000
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

/**
 * Coarse "last updated" label — minutes to months.
 *
 * Buckets come from the plain epoch difference, never from calendar fields, so
 * the server-rendered string and the hydrating client agree regardless of their
 * respective time zones.
 */
export function lastUpdatedLabel(ms: number | null, nowMs: number): string | null {
  if (ms === null) return null
  const diff = nowMs - ms
  if (diff < 0) return 'just now'
  if (diff < MINUTE) return 'just now'
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  if (diff < HOUR) return rtf.format(-Math.floor(diff / MINUTE), 'minute')
  if (diff < DAY) return rtf.format(-Math.floor(diff / HOUR), 'hour')
  if (diff < WEEK) return rtf.format(-Math.floor(diff / DAY), 'day')
  if (diff < 5 * WEEK) return rtf.format(-Math.floor(diff / WEEK), 'week')
  return rtf.format(-Math.floor(diff / (30 * DAY)), 'month')
}

/** ISO date for the `title` tooltip beside a relative label. */
export function absoluteDate(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString().slice(0, 10)
}

/**
 * Up to two initials for the owner avatar, from a display name. A single-word
 * name — usernames like `admin` have no surname — gives its first two
 * characters. Peer avatars spell initials differently, in
 * `#shared/utils/presence`.
 */
export function ownerInitials(name: string | undefined | null): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return ''
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
}
