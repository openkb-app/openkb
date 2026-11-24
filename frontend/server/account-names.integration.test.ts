import { describe, it, expect, beforeAll, vi } from 'vitest'
import { fetchAccountNames } from './utils/account-names'

/**
 * Agent reads name accounts through the collab server's own token.
 *
 * The `collab_server` role grants no user view access: simple_oauth adds
 * `authenticated` to the token, and that role holds `access user profiles`.
 *
 * Needs the full docker stack; see collaboration.integration.test.ts.
 */

const DRUPAL_URL = (process.env.DRUPAL_BASE_URL ?? 'http://openkb-dev-project.localdev.space:8081').replace(/\/$/, '')

/**
 * A Drupal session cookie of the admin account.
 */
async function adminCookie(): Promise<string> {
  const res = await fetch(`${DRUPAL_URL}/user/login`, {
    method: 'POST',
    body: new URLSearchParams({
      name: 'admin',
      pass: process.env.OKB_ADMIN_PASS ?? 'yKCE5gSqOk2z7WmLO7__gAqv',
      form_id: 'user_login_form',
      op: 'Log in',
    }),
    redirect: 'manual',
  })
  const cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).find(c => /^S?SESS/.test(c))
  if (!cookie) throw new Error(`Drupal login failed (status ${res.status}, no SESS cookie)`)
  return cookie
}

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
    const permissions = await collabServerPermissions(await adminCookie())
    expect(permissions).toContain('use collaboration api')
    expect(permissions).not.toContain('access user profiles')

    expect(await fetchAccountNames([1])).toEqual(new Map([[1, 'admin']]))
  })
})
