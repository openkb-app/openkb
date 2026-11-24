import { defineEventHandler, getQuery } from 'h3'
import { isAccountUid } from '#shared/utils/account-lookup'
import { fetchAccounts } from '../../utils/account-names'
import { forwardedAuthHeaders } from '../../utils/actor'

/**
 * User search for the editor's @-mention suggestion popover.
 *
 * Also backs the space members form, which adds users to a roster, and the
 * mention chips, which read accounts' current names by `?uid=1,2`.
 *
 * Forwards the caller's Drupal session cookie to JSON:API so the result set
 * respects per-role view permissions on user entities. Returns a slim shape:
 * uid + name render the chip the editor stores, `id` is the UUID the roster
 * PATCH writes as a JSON:API relationship.
 */
export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const q = String(query.q ?? '').trim()
  const uids = String(query.uid ?? '').split(',').map(Number).filter(isAccountUid)
  if (uids.length > 0) return { users: await fetchAccounts(forwardedAuthHeaders(event), { uids }) }
  if (q.length === 0) return { users: [] }
  return { users: await fetchAccounts(forwardedAuthHeaders(event), { name: q }) }
})
