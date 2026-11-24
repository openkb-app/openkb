import { DrupalJsonApiParams } from 'drupal-jsonapi-params'
import { ACCOUNT_LOOKUP_LIMIT, isAccountUid } from '#shared/utils/account-lookup'
import { asCollabServer, collabIdentityConfigured } from './collab-identity'
import { drupalFetchWithAuth } from './drupal'

/** One account, as the user search and the name lookup serve it. */
export interface AccountHit {
  /** The UUID a roster PATCH writes as a JSON:API relationship. */
  id: string
  uid: number
  name: string
}

interface JsonApiUserResp {
  data: Array<{
    id: string
    attributes: { name: string, drupal_internal__uid: number }
  }>
}

/**
 * Accounts from JSON:API, as the carrier may see them: by name, or by uid.
 * Per-role user view access holds for the carrier `auth` names.
 */
export async function fetchAccounts(
  auth: Record<string, string>,
  filter: { name: string } | { uids: number[] },
): Promise<AccountHit[]> {
  const params = new DrupalJsonApiParams()
    .addFields('user--user', ['name', 'drupal_internal__uid'])
  if ('uids' in filter) {
    const uids = filter.uids.slice(0, ACCOUNT_LOOKUP_LIMIT)
    if (uids.length === 0) return []
    params.addFilter('drupal_internal__uid', uids.map(String), 'IN').addPageLimit(ACCOUNT_LOOKUP_LIMIT)
  }
  else {
    params.addFilter('name', filter.name, 'CONTAINS').addPageLimit(8)
  }
  const json = await drupalFetchWithAuth<JsonApiUserResp>(
    auth,
    `/jsonapi/user/user?${params.getQueryString({ encodeValuesOnly: true })}`,
  )
  return (json.data ?? []).map(user => ({
    id: user.id,
    uid: user.attributes.drupal_internal__uid,
    name: user.attributes.name,
  }))
}

/**
 * The current names of accounts a comment thread names, by uid; an unknown uid is absent.
 *
 * Read as the collab server, not the caller: a thread's stored labels already
 * name these accounts, and an agent token may view no account but its own.
 */
export async function fetchAccountNames(uids: Iterable<number>): Promise<Map<number, string>> {
  const wanted = [...new Set(uids)].filter(isAccountUid)
  const names = new Map<number, string>()
  if (wanted.length === 0 || !collabIdentityConfigured()) return names
  try {
    for (let start = 0; start < wanted.length; start += ACCOUNT_LOOKUP_LIMIT) {
      const page = await asCollabServer(auth => fetchAccounts(auth, { uids: wanted.slice(start, start + ACCOUNT_LOOKUP_LIMIT) }))
      for (const account of page) names.set(account.uid, account.name)
    }
  }
  catch {
    // Names are a courtesy on top of the stored labels, never a reason to fail a read.
  }
  return names
}
