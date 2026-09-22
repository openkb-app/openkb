import type { H3Event } from 'h3'
import { createError } from 'h3'
import { drupalBaseUrl } from './drupal'
import { fetchUpstream, UPSTREAM_UNAVAILABLE } from './upstream'
import { forwardedAuthHeaders } from './actor'

/**
 * Where the caller may work, as Drupal answers it (`GET /openkb/spaces`).
 *
 * Drupal is the access authority (ADR 0004) and this is its answer in one
 * document: every space the calling account may at least read, with the most
 * privileged level it holds there. The chrome draws its manage controls from
 * it instead of probing Drupal per space.
 *
 * Read once per request and shared by every consumer. There is no
 * cross-request cache: the route declares the `user` cache context, and
 * dynamic_page_cache refuses to store any response carrying it
 * (`renderer.config.auto_placeholder_conditions.contexts`). Every request
 * pays one Drupal bootstrap for the map, and one is the whole budget:
 * nothing asks Drupal per space.
 *
 * **Fail closed.** A map that cannot be read raises — there is no unfiltered
 * fallback and no empty success. A caller that would rather hide a control
 * than fail a page catches it and treats the answer as "nothing", which is the
 * same refusal one step later.
 */

/** One space the caller may operate on. */
export interface SpaceAccess {
  slug: string
  name: string
  description: string
  /** The most privileged level held here: read < write < manage. */
  access: 'read' | 'write' | 'manage'
  moderated: boolean
}

/** The levels an `access` filter accepts, least privileged first. */
const RANKS = ['read', 'write', 'manage'] as const

/**
 * The caller's access map, fetched once per request.
 *
 * @throws When Drupal does not answer the map — unreachable, refusing the
 *   caller, or serving something that is not a space list.
 */
export function spaceAccessMap(event: H3Event): Promise<SpaceAccess[]> {
  const cached = event.context.okbSpaceAccess as Promise<SpaceAccess[]> | undefined
  if (cached) return cached

  const promise = fetchSpaceAccessMap(event)
  event.context.okbSpaceAccess = promise
  return promise
}

async function fetchSpaceAccessMap(event: H3Event): Promise<SpaceAccess[]> {
  const auth = forwardedAuthHeaders(event)
  // The route is for logged-in accounts; an anonymous read is a refusal Drupal
  // logs, so it is refused here without the round trip. Fail closed either way.
  if (Object.keys(auth).length === 0) {
    throw createError({ statusCode: 403, statusMessage: 'Sign in to read your spaces.' })
  }

  let response: Response
  try {
    response = await fetchUpstream(`${drupalBaseUrl()}/openkb/spaces`, {
      headers: { Accept: 'application/json', ...auth },
    })
  }
  catch {
    throw createError({ statusCode: 503, statusMessage: UPSTREAM_UNAVAILABLE })
  }
  if (!response.ok) {
    throw createError({
      statusCode: response.status >= 500 ? 503 : response.status,
      statusMessage: response.status >= 500 ? UPSTREAM_UNAVAILABLE : 'Space access could not be read.',
    })
  }

  const body = await response.json().catch(() => null) as { spaces?: unknown } | null
  if (!body || !Array.isArray(body.spaces)) {
    throw createError({ statusCode: 503, statusMessage: UPSTREAM_UNAVAILABLE })
  }
  return body.spaces.map(toSpaceAccess).filter((space): space is SpaceAccess => space !== null)
}

/** Drops an entry that carries no usable slug or level. */
function toSpaceAccess(entry: unknown): SpaceAccess | null {
  const { slug, name, description, access, moderated } = (entry ?? {}) as Record<string, unknown>
  if (typeof slug !== 'string' || slug === '') return null
  if (typeof access !== 'string' || !RANKS.includes(access as SpaceAccess['access'])) return null
  return {
    slug,
    name: typeof name === 'string' ? name : '',
    description: typeof description === 'string' ? description : '',
    access: access as SpaceAccess['access'],
    moderated: moderated === true,
  }
}

/** Whether `access` is at least `minimum` on the read < write < manage scale. */
export function atLeast(access: SpaceAccess['access'], minimum: SpaceAccess['access']): boolean {
  return RANKS.indexOf(access) >= RANKS.indexOf(minimum)
}

/**
 * The caller's access map keyed by slug, or an empty map when it cannot be
 * read.
 *
 * For the surfaces that answer "may I?" about a control rather than about a
 * result: a map that did not arrive answers "no" for every space, so the
 * control is not drawn and Drupal still decides the write. Search does not use
 * this — an unanswerable map there is an error, not an empty result.
 */
export async function spaceAccessBySlug(event: H3Event): Promise<Map<string, SpaceAccess>> {
  try {
    const spaces = await spaceAccessMap(event)
    return new Map(spaces.map(space => [space.slug, space]))
  }
  catch {
    return new Map()
  }
}
