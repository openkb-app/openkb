/**
 * Sign-in against the running stack, for the `integration` vitest project.
 *
 * The port is the one the surrounding frontend container listens on: local
 * stacks raise it to the published host port; elsewhere it is nitro's 3000.
 */

export const PORT = process.env.NUXT_PORT ?? process.env.NITRO_PORT ?? '3000'
export const DRUPAL_URL = (process.env.DRUPAL_BASE_URL ?? 'http://openkb-dev-project.localdev.space:8081').replace(/\/$/, '')
export const NUXT_URL = (process.env.OKB_NUXT_URL ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, '')

const ADMIN_PASS = process.env.OKB_ADMIN_PASS ?? 'yKCE5gSqOk2z7WmLO7__gAqv'

/** Signs an account in through Drupal's login form and returns its session cookie. */
export async function drupalLogin(name = 'admin', pass = ADMIN_PASS): Promise<string> {
  const res = await fetch(`${DRUPAL_URL}/user/login`, {
    method: 'POST',
    body: new URLSearchParams({ name, pass, form_id: 'user_login_form', op: 'Log in' }),
    redirect: 'manual',
  })
  const cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).find(c => /^S?SESS/.test(c ?? ''))
  if (!cookie) throw new Error(`Drupal login failed for ${name} (status ${res.status}, no SESS cookie)`)
  return cookie
}

/** The session's CSRF token, read the way the app reads it. */
export async function sessionToken(cookie: string): Promise<string> {
  return (await (await fetch(`${NUXT_URL}/session/token`, { headers: { Cookie: cookie } })).text()).trim()
}
