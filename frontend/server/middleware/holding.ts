import type { H3Event } from 'h3'
import { defineEventHandler, getHeader, setResponseHeader, setResponseStatus } from 'h3'
import { escapeHtml } from '@vue/shared'
import { drupalBaseUrl } from '../utils/drupal'

/**
 * The page a browser gets while Drupal cannot serve the site yet.
 *
 * Two states answer this way, and Drupal names which in `X-OpenKB-Hold`:
 * `install` is the first boot, where the container is still installing the
 * site, and `update` is a container that booted on a newer image whose
 * database updates have not run.
 *
 * Middleware rather than the error boundary: the route guard sends a visitor
 * without a session to the sign-in page before any backend call is made, so a
 * first-time visitor would be told to sign in to a site that does not exist
 * yet. This runs ahead of routing and holds every path.
 */

type Hold = 'install' | 'update'

/** How long one probe's answer stands for. */
const PROBE_TTL_MS = 10_000

/** A backend that does not answer in this is treated as not holding. */
const PROBE_TIMEOUT_MS = 5_000

let hold: Hold | null = null
let probedAt = 0

/** A caller that takes HTML is the only one this page is for. */
function acceptsHtml(event: H3Event): boolean {
  return /\btext\/html\b/i.test(getHeader(event, 'accept') ?? '')
}

/**
 * What Drupal says is holding the site, or null when nothing is.
 *
 * The schema route is what the app fetches anonymously on every page, so it is
 * both cheap and subject to maintenance mode. Anything but a hold header — a
 * served site, an unreachable one — is not this page's case and falls through
 * to the app's own error handling.
 */
async function currentHold(): Promise<Hold | null> {
  const now = Date.now()
  if (now - probedAt < PROBE_TTL_MS) {
    return hold
  }
  probedAt = now
  try {
    const res = await fetch(`${drupalBaseUrl()}/openkb/schema`, { method: 'HEAD', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    const header = res.headers.get('x-openkb-hold')
    hold = header === 'install' || header === 'update' ? header : null
  }
  catch {
    hold = null
  }
  return hold
}

/** The held page, kept to what it can say without the backend. */
function page(state: Hold): string {
  const lead = state === 'update'
    ? 'An update is pending'
    : 'Setting up OpenKnowledgebase…'
  // Drupal is a host of its own, so the admin's two steps are absolute links.
  const drupal = escapeHtml(drupalBaseUrl())
  const detail = state === 'update'
    ? `An administrator <a href="${drupal}/user/login">signs in</a> and runs <a href="${drupal}/update.php">update.php</a>.`
    : 'Back in a minute. This page reloads itself.'
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="10">
<title>${lead} · OpenKnowledgebase</title>
<style>
:root { color-scheme: light dark; --okb-ground: #f5f6f9; --okb-surface: #fff; --okb-text: #171a26; --okb-text-muted: #5a5f76; --okb-border: #e0e2ea; }
@media (prefers-color-scheme: dark) {
  :root { --okb-ground: #141620; --okb-surface: #1d202c; --okb-text: #eef0f5; --okb-text-muted: #a3a7ba; --okb-border: #2c3040; }
}
body { margin: 0; min-height: 100svh; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--okb-ground); color: var(--okb-text); font: 400 14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 28rem; padding: 32px; border-radius: 14px; background: var(--okb-surface); box-shadow: 0 0 0 1px var(--okb-border); text-align: center; }
h1 { margin: 20px 0 8px; font-size: 20px; letter-spacing: -0.01em; }
p { margin: 0; color: var(--okb-text-muted); }
a { color: inherit; }
</style>
</head>
<body>
<main>
<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true"><style>.ring{fill:#4c5a9e}.leaf{fill:#10b981}@media (prefers-color-scheme:dark){.ring{fill:#a6b3d9}.leaf{fill:#34d399}}</style><mask id="m"><rect width="48" height="48" fill="white"/><circle cx="16" cy="24" r="15.5" fill="black"/></mask><rect class="leaf" x="18" y="10" width="26" height="28" rx="8" mask="url(#m)"/><circle class="ring" cx="16" cy="24" r="13"/></svg>
<h1>${lead}</h1>
<p>${detail}</p>
</main>
</body>
</html>
`
}

export default defineEventHandler(async (event) => {
  if (!acceptsHtml(event)) {
    return
  }
  const state = await currentHold()
  if (!state) {
    return
  }
  setResponseStatus(event, 503)
  setResponseHeader(event, 'retry-after', '10')
  setResponseHeader(event, 'x-openkb-hold', state)
  setResponseHeader(event, 'cache-control', 'no-store')
  setResponseHeader(event, 'content-type', 'text/html; charset=utf-8')
  return page(state)
})
