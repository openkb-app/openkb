/**
 * How the API-clients listing words a client's dates.
 *
 * Drupal sends UTC instants: `created` is when the client was connected,
 * `lastUsed` the last token issued for it — which Drupal keeps to the hour, so
 * a date is the whole of what it can honestly say. Both are optional on the
 * wire, so each cell has a word for the absence rather than an empty box.
 */

/** One client, as the CE page states it. */
export interface ApiClient {
  label: string
  clientId: string
  revoked: boolean
  created?: string | null
  lastUsed?: string | null
  revokeUrl?: string | null
}

/** Short absolute date; the listing is a record, not a live feed. */
export function clientDate(at?: string | null): string | null {
  if (!at) return null
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** The "Connected" cell, including for a client whose date did not survive. */
export function connectedCell(at?: string | null): string {
  return clientDate(at) ?? 'Unknown'
}

/** The "Last used" cell, including the client no token was ever issued for. */
export function lastUsedCell(at?: string | null): string {
  return clientDate(at) ?? 'Never'
}
