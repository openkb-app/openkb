import type { H3Event } from 'h3'
import { getHeader } from 'h3'
import { fetchUpstream, upstreamError } from './upstream'
import { drupalBaseUrl } from './drupal'

/**
 * Actor resolution for the frontend server layer.
 *
 * Every server route acts on Drupal *on behalf of the incoming request* —
 * Drupal enforces all permissions, the Nuxt layer grants nothing. Two auth
 * carriers exist: the Drupal session cookie (a human in the browser) and an
 * `Authorization: Bearer` agent token (a simple_oauth token carrying an agent
 * scope, acting as its owner's account — see openkb_agent). This module owns
 * the one rule for which carrier a request acts under, and resolves *who* that
 * is.
 *
 * The identity contract is `GET /openkb/agent/identity` → `{ uid, name, via }`:
 * `uid`/`name` are always the human account the request acts as; `via` is the
 * consumer label ("Claude") for token auth, null for a session. Consumers
 * (commit attribution, rate limiting, the MCP tools) render "fago via Claude"
 * from it.
 */

/** The resolved acting identity of a request. */
export interface Actor {
  /** bearer token ⇒ agent, session cookie ⇒ human, neither ⇒ anonymous. */
  type: 'agent' | 'human' | 'anonymous'
  /** Drupal uid of the account the request acts as; null when anonymous. */
  uid: number | null
  /** Account name; null when anonymous. */
  name: string | null
  /** Agent client's label for token auth ("Claude"); null otherwise. */
  via: string | null
}

export const ANONYMOUS_ACTOR: Actor = Object.freeze({
  type: 'anonymous',
  uid: null,
  name: null,
  via: null,
})

/**
 * The auth headers a request's upstream Drupal calls forward.
 *
 * A Bearer token wins over a session cookie: an agent request may ride
 * alongside browser cookies on the same host, and forwarding both would let
 * Drupal's cookie authentication mask the token's (narrower, scope-ceilinged)
 * permissions. Exactly one carrier is ever forwarded.
 */
export function forwardedAuthHeaders(event: H3Event): Record<string, string> {
  const authorization = getHeader(event, 'authorization')
  if (authorization && /^Bearer /i.test(authorization)) {
    return { Authorization: authorization }
  }
  const cookie = getHeader(event, 'cookie')
  if (cookie) return { Cookie: cookie }
  return {}
}

/**
 * Resolves the acting identity of a request — once; repeated calls reuse the
 * per-request cache on `event.context`, so any number of consumers (commit
 * attribution, rate limiting, MCP tools) share one upstream round-trip.
 *
 * Unauthenticated requests resolve to {@link ANONYMOUS_ACTOR} without an
 * upstream call. The identity route requires a logged-in account, so a
 * carrier Drupal does not honor as a login — typically a stale session
 * cookie — comes back 403 and resolves to anonymous too. An invalid/expired
 * *token* is different: simple_oauth rejects it with 401 during
 * authentication, and that passes through as an error rather than being
 * misread as anonymous — the caller presented explicit credentials that are
 * bad.
 */
export async function resolveActor(event: H3Event): Promise<Actor> {
  const cached = event.context.okbActor as Promise<Actor> | undefined
  if (cached) return cached

  const auth = forwardedAuthHeaders(event)
  const promise = Object.keys(auth).length === 0
    ? Promise.resolve(ANONYMOUS_ACTOR)
    : fetchIdentity(auth)
  event.context.okbActor = promise
  return promise
}

async function fetchIdentity(auth: Record<string, string>): Promise<Actor> {
  const res = await fetchUpstream(`${drupalBaseUrl()}/openkb/agent/identity`, {
    headers: { Accept: 'application/json', ...auth },
  })
  if (res.status === 403) return ANONYMOUS_ACTOR
  if (!res.ok) throw await upstreamError(res, 'agent identity')
  const identity = (await res.json()) as { uid: number, name: string, via: string | null }
  if (!identity.uid) return ANONYMOUS_ACTOR
  return {
    type: identity.via != null ? 'agent' : 'human',
    uid: identity.uid,
    name: identity.name,
    via: identity.via ?? null,
  }
}
