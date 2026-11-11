import { describe, it, expect, beforeAll } from 'vitest'

/**
 * ADR 0019 from the caller's side, against the running dev server: a cookie
 * write passes only with the token of its own session.
 *
 * Needs the full docker stack; see collaboration.integration.test.ts.
 */

const PORT = process.env.NUXT_PORT ?? process.env.NITRO_PORT ?? '3000'
const DRUPAL_URL = (process.env.DRUPAL_BASE_URL ?? 'http://openkb-dev-project.localdev.space:8081').replace(/\/$/, '')
const NUXT_URL = (process.env.OKB_NUXT_URL ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, '')

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

async function sessionToken(cookie: string): Promise<string> {
  return (await (await fetch(`${NUXT_URL}/session/token`, { headers: { Cookie: cookie } })).text()).trim()
}

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
    cookie = await adminCookie()
    ownToken = await sessionToken(cookie)
    otherToken = await sessionToken(await adminCookie())
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
