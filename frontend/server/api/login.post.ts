import { defineEventHandler, readBody, createError, setResponseHeader } from 'h3'
import { fetchUpstream, UPSTREAM_UNAVAILABLE } from '../utils/upstream'

/**
 * Proxies username/password to Drupal's JSON login endpoint
 * (POST /user/login?_format=json) and forwards the Set-Cookie header
 * verbatim. Drupal issues a `SESS*` cookie scoped to the parent host
 * (SESSION_COOKIE_DOMAIN), so the browser auto-attaches it on both
 * the Drupal and Nuxt subdomains.
 *
 * Status contract the login form maps to its two distinct messages:
 *   200 — signed in
 *   400 — no credentials submitted
 *   401 — Drupal rejected the credentials
 *   503 — Drupal unreachable or broken
 * A user who typed the right password must never be told it was wrong, so
 * the credential branch is strictly Drupal's own 4xx rejection.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ name?: string, pass?: string }>(event)
  if (!body?.name || !body?.pass) {
    throw createError({ statusCode: 400, statusMessage: 'Missing credentials' })
  }

  const config = useRuntimeConfig()
  const drupalBase = (config.drupalBaseUrl as string).replace(/\/$/, '')

  const res = await fetchUpstream(`${drupalBase}/user/login?_format=json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ name: body.name, pass: body.pass }),
  })

  if (res.status >= 500) {
    console.error(`[login] Drupal login endpoint → ${res.status}`)
    throw createError({ statusCode: 503, statusMessage: UPSTREAM_UNAVAILABLE })
  }
  if (!res.ok) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid username or password' })
  }

  const setCookie = res.headers.get('set-cookie')
  if (setCookie) {
    setResponseHeader(event, 'set-cookie', setCookie)
  }

  return { ok: true }
})
