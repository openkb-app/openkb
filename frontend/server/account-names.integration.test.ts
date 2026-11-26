import { describe, it, expect, beforeAll, vi } from 'vitest'
import { fetchAccountNames } from './utils/account-names'
import { DRUPAL_URL, drupalLogin } from './test-support/drupal-session'

/**
 * Agent reads name accounts through the collab server's own token.
 *
 * The `collab_server` role grants no user view access: simple_oauth adds
 * `authenticated` to the token, and that role holds `access user profiles`.
 *
 * Needs the full docker stack; see collaboration.integration.test.ts.
 */

/**
 * The permissions the site's `collab_server` role holds.
 */
async function collabServerPermissions(cookie: string): Promise<string[]> {
  const res = await fetch(`${DRUPAL_URL}/jsonapi/user_role/user_role?filter[drupal_internal__id]=collab_server`, {
    headers: { Cookie: cookie, Accept: 'application/vnd.api+json' },
  })
  const json = await res.json() as { data: Array<{ attributes: { permissions: string[] } }> }
  expect(json.data).toHaveLength(1)
  return json.data[0]!.attributes.permissions
}

describe('account names for agent reads', () => {
  beforeAll(() => {
    vi.stubGlobal('useRuntimeConfig', () => ({ drupalBaseUrl: DRUPAL_URL, public: {} }))
  })

  it('reads current names while collab_server lacks access user profiles', async () => {
    const permissions = await collabServerPermissions(await drupalLogin())
    expect(permissions).toContain('use collaboration api')
    expect(permissions).not.toContain('access user profiles')

    expect(await fetchAccountNames([1])).toEqual(new Map([[1, 'admin']]))
  })
})
