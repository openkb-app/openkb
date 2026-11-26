import { describe, it, expect, beforeAll } from 'vitest'
import { NUXT_URL, drupalLogin, sessionToken } from './test-support/drupal-session'

/**
 * ADR 0019 from the caller's side, against the running dev server: a cookie
 * write passes only with the token of its own session.
 *
 * Needs the full docker stack; see collaboration.integration.test.ts.
 */

/**
 * Dry-run writes: Drupal validates, nothing is stored.
 *
 * - The Nitro route is exempt from the frontend server's check: Drupal refuses it.
 * - The Drupal proxy is checked by the frontend server.
 */
const WRITES = [
  ['a Nitro route Drupal checks', '/api/node/1/validate'],
  ['the Drupal proxy', '/api/drupal/openkb/node/1/validate'],
] as const

describe('CSRF token from the caller', () => {
  let cookie: string
  let ownToken: string
  let otherToken: string

  beforeAll(async () => {
    cookie = await drupalLogin()
    ownToken = await sessionToken(cookie)
    otherToken = await sessionToken(await drupalLogin())
  })

  function write(path: string, token?: string): Promise<Response> {
    return fetch(`${NUXT_URL}${path}`, {
      method: 'POST',
      headers: {
        'Cookie': cookie,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        ...(token ? { 'X-CSRF-Token': token } : {}),
      },
      body: JSON.stringify({ fields: {} }),
    })
  }

  it('reads distinct tokens for two sessions of one account', () => {
    expect(ownToken).not.toBe('')
    expect(otherToken).not.toBe(ownToken)
  })

  it.each(WRITES)('%s refuses a cookie write without a token', async (_, path) => {
    expect((await write(path)).status).toBe(403)
  })

  it.each(WRITES)('%s refuses a cookie write with another session\'s token', async (_, path) => {
    expect((await write(path, otherToken)).status).toBe(403)
  })

  it.each(WRITES)('%s takes a cookie write with the session\'s own token', async (_, path) => {
    const res = await write(path, ownToken)
    expect(res.status, await res.clone().text()).toBe(200)
  })
})
