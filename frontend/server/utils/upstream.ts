import { createError, appendResponseHeader, type H3Event } from 'h3'

/**
 * Error mapping for every server route that talks to Drupal.
 *
 * Two failure classes must stay distinguishable in the UI:
 *   - the backend answered and rejected the request (4xx) — the user can act
 *     on it (wrong credentials, missing page, no access),
 *   - the backend is unreachable or broken (transport failure, 5xx) — the user
 *     can only retry later.
 *
 * The second class collapses to **503**, so the frontend can say "temporarily
 * unavailable" instead of "your request was wrong". Upstream response bodies,
 * URLs and status text never reach the client: they identify internal
 * infrastructure and mean nothing to a reader. They go to the server log
 * instead. {@link upstreamError} lists the three exceptions.
 */

/** Human-facing statusMessage for the unavailable class. */
export const UPSTREAM_UNAVAILABLE = 'Service temporarily unavailable'

/**
 * Passes Drupal's `Set-Cookie` on to the caller.
 *
 * Drupal owns the session, so it is also the only side that can end one, and
 * it says so in this header: signing out through the account menu is a page
 * request like any other, and the cookie expiry rides back on its response.
 * A proxy that returns only the body leaves the browser holding a cookie whose
 * session is already dead — which the route guard, gating on cookie presence,
 * keeps honouring.
 *
 * Relayed verbatim, never rewritten: the cookie's domain is host-only on one
 * deployment and a shared parent domain on another (CI serves Drupal and Nuxt
 * as sibling hosts under one wildcard), and only the side that set it knows
 * which. A `Set-Cookie` whose domain does not match the one it was set on
 * deletes nothing.
 */
export function relaySetCookie(event: H3Event, res: Response): void {
  for (const value of res.headers.getSetCookie()) {
    appendResponseHeader(event, 'set-cookie', value)
  }
}

/** One JSON:API error object, as far as this app reads them. */
export interface Violation {
  detail?: string
  source?: { pointer?: string }
  /** Structured payload the error carries — the publish gate's blocker facts. */
  meta?: { item?: string, steps?: string[] }
}

/** The two timestamps a refused stale commit disagrees about. */
export interface ConflictFacts {
  expected: number
  actual: number
}

/** Maps an upstream HTTP status to the status this app reports. */
export function mapUpstreamStatus(status: number): number {
  return status >= 500 ? 503 : status
}

/**
 * Wraps `fetch` so a transport failure (DNS, refused connection, timeout)
 * becomes a 503 instead of an unhandled rejection rendered as a raw 500.
 */
export async function fetchUpstream(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init)
  }
  catch (e) {
    console.error(`[upstream] unreachable: ${url}`, e)
    throw createError({ statusCode: 503, statusMessage: UPSTREAM_UNAVAILABLE })
  }
}

/** The two timestamps a 409's first error carries, when it carries them. */
function conflictFacts(errors: Violation[] | undefined): ConflictFacts | undefined {
  const meta = (errors?.[0] as { meta?: Partial<ConflictFacts> } | undefined)?.meta
  return typeof meta?.expected === 'number' && typeof meta?.actual === 'number'
    ? { expected: meta.expected, actual: meta.actual }
    : undefined
}

/**
 * Turns a non-ok upstream response into the error this app reports. `context`
 * and the upstream body are logged, never returned — with three deliberate
 * exceptions, all user-actionable and none naming infrastructure:
 *
 *   - a 422's JSON:API violations (detail, source pointer, and any `meta` the
 *     error carries) ride along in `data.violations`. Validation messages name
 *     the field and the rule, and the commit path maps them back onto the form
 *     (violationFields in commit.ts). The publish gate's refusal travels the
 *     same way, naming the blocking blocks in `meta` (OKB-121).
 *   - a 409's two timestamps ride along in `data.conflict`. They are how the
 *     commit path tells a refused stale commit from every other rejection, and
 *     what the reload banner reads.
 *   - a 403's first JSON:API `detail` becomes the statusMessage. One route can
 *     refuse for several reasons that ask the caller for different things, and
 *     only Drupal's own sentence tells them apart.
 */
export async function upstreamError(res: Response, context: string, responseBody?: string) {
  const status = mapUpstreamStatus(res.status)
  // A caller that had to read the body itself (the delete path inspects it for
  // a deadlock) hands it over — a Response body can only be consumed once.
  const body = responseBody ?? await res.text().catch(() => '')
  console.error(`[upstream] ${context} → ${res.status}: ${body.slice(0, 500)}`)
  let errors: Violation[] | undefined
  if (status < 500) {
    try {
      errors = (JSON.parse(body) as { errors?: Violation[] }).errors
    }
    catch { /* not JSON — nothing to map */ }
  }
  const violations = status === 422
    ? errors?.map(({ detail, source, meta }) => ({ detail, source, meta }))
    : undefined
  const conflict = status === 409 ? conflictFacts(errors) : undefined
  const refusal = status === 403 ? errors?.[0]?.detail : undefined
  return createError({
    statusCode: status,
    statusMessage: status === 503
      ? UPSTREAM_UNAVAILABLE
      : (refusal ?? `Request failed (${status})`),
    ...(violations?.length ? { data: { violations } } : {}),
    ...(conflict ? { data: { conflict } } : {}),
  })
}
