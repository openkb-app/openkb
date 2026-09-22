import type { H3Event } from 'h3'
import { createError } from 'h3'
import { DrupalJsonApiParams } from 'drupal-jsonapi-params'
import { drupalFetch, jsonApiNextPath, sitePermissions, JSONAPI_PAGE_SIZE, type JsonApiPage } from './drupal'
import { UPSTREAM_UNAVAILABLE } from './upstream'
import { forwardedAuthHeaders } from './actor'
import { atLeast, spaceAccessBySlug } from './space-access'
import { SPACE_TYPE, SPACE_CREATE_PERMISSION, spaceSlug, type KbSpaceDetail, type KbSpaceMember, type KbSpaceSummary, type KbSpaceReadAccess } from '#shared/utils/kb-spaces'
import { parseOutline, sanitiseOutline, type Outline } from '#shared/utils/kb-outline'

/**
 * Spaces as the frontend reads and writes them.
 *
 * A space is an `openkb_space` entity; its roster lives on the space itself in
 * three multi-value user references, ranked — `managers` (manage + write),
 * `members` (write) and `viewers` (read only). The space is the aggregate
 * root: one JSON:API PATCH replaces the whole roster, which is exactly the
 * granularity the decoupled members form works at.
 *
 * A space's URL is its path alias, which Drupal writes from the name; the
 * slug every read here is keyed by is that alias without its leading slash.
 *
 * Every call forwards the caller's auth carrier, so Drupal decides what is
 * readable and writable. Two consequences the callers rely on:
 *   - a session that may not view user entities gets empty rosters, not an
 *     error — the space itself still renders,
 *   - roster writes are gated by space update access, surfaced ahead of time
 *     as {@link KbSpaceDetail.canManage} so the UI can hide controls that
 *     would 403. That answer comes from the space access map
 *     (server/utils/space-access.ts) — one read for every space at once,
 *     shared with search.
 *
 * The page tree is the one write that is not a space PATCH: it has a Drupal
 * route of its own (`PUT /openkb/space/<id>/outline`) answering to whether the
 * caller may restructure the space rather than to whether it may administer it.
 */

interface SpaceResource {
  id: string
  attributes: {
    label: string
    description?: string | null
    drupal_internal__id: number
    path?: { alias?: string | null } | null
    read_access?: string | null
    field_moderation?: boolean | null
    outline?: string | null
  }
  relationships?: Record<string, { data?: Array<{ id: string, type: string }> | null }>
}

interface SpacePage extends JsonApiPage {
  data?: SpaceResource[]
}

interface UserResource {
  type: string
  id: string
  attributes: { name?: string, display_name?: string, drupal_internal__uid?: number }
}

/** A space reduced to what the frontend needs, minus the roster. */
export interface SpaceSummary extends KbSpaceSummary {
  /** The space's page tree (OKB-87), as stored — un-swept. */
  outline: Outline
  /** Only present when listed with `withAccess`. */
  canManage?: boolean
  /** Only present when listed with `withAccess`. */
  canWrite?: boolean
}

function toSummary(space: SpaceResource): SpaceSummary {
  return {
    id: space.id,
    internalId: space.attributes.drupal_internal__id,
    name: space.attributes.label,
    slug: spaceSlug(space.attributes.path?.alias ?? ''),
    description: space.attributes.description ?? '',
    // Anything but the explicit all-users value reads as members-only, the same
    // strict default Drupal applies.
    readAccess: space.attributes.read_access === 'all_users' ? 'all_users' : 'members_only',
    // Unset reads as moderated, the same strict default Drupal applies: a
    // space whose flag was never written keeps review rather than silently
    // going live-on-save.
    moderation: space.attributes.field_moderation ?? true,
    outline: parseOutline(space.attributes.outline),
  }
}

/** Maps the `included` user resources of a space document by UUID. */
export function indexUsers(included: UserResource[] | undefined): Map<string, KbSpaceMember> {
  const users = new Map<string, KbSpaceMember>()
  for (const resource of included ?? []) {
    if (resource.type !== 'user--user') continue
    users.set(resource.id, {
      id: resource.id,
      uid: resource.attributes.drupal_internal__uid ?? 0,
      // Same precedence as the @-mention search and /api/me.
      name: resource.attributes.display_name ?? resource.attributes.name ?? '',
    })
  }
  return users
}

/**
 * Resolves one roster field of a space document. References whose user the
 * session may not view are dropped rather than rendered as blanks — Drupal
 * omits them from `included`.
 */
export function rosterOf(
  space: SpaceResource,
  field: 'managers' | 'members' | 'viewers',
  users: Map<string, KbSpaceMember>,
): KbSpaceMember[] {
  const refs = space.relationships?.[field]?.data ?? []
  return refs
    .map(ref => users.get(ref.id))
    .filter((user): user is KbSpaceMember => !!user)
}

const SPACE_FIELDS = ['label', 'path', 'description', 'drupal_internal__id', 'read_access', 'field_moderation', 'managers', 'members', 'viewers', 'outline']
const USER_FIELDS = ['name', 'display_name', 'drupal_internal__uid']

/**
 * Lists every space the session may see, sorted by name.
 *
 * Follows JSON:API's `next` to exhaustion; core clamps `page[limit]` to
 * `JSONAPI_PAGE_SIZE`. A space missing here is a space the chrome cannot put
 * in context — the switcher reads "All spaces", the sidebar renders no page
 * roster, and `useCanCreatePage` refuses the CTA.
 *
 * With `withAccess`, each space also carries what the session may do in it —
 * manage, which decides before any drag starts which trees are rearrangeable,
 * and write, which is the per-space half of whether a page may be created
 * there and, where the space runs no review, whether its tree may be
 * rearranged. It costs one access-map read for the whole listing, whatever its
 * length.
 */
export async function listSpaces(
  event: H3Event,
  options: { withAccess?: boolean } = {},
): Promise<SpaceSummary[]> {
  const params = new DrupalJsonApiParams()
    .addFields(SPACE_TYPE, SPACE_FIELDS)
    // Names are not unique, and two that compare equal under the sort
    // collation are an unordered tie: paging one repeats a row on a page and
    // skips another. The entity id breaks it.
    .addSort('label', 'ASC')
    .addSort('drupal_internal__id', 'ASC')
    .addPageLimit(JSONAPI_PAGE_SIZE)

  const resources: SpaceResource[] = []
  let path: string | null
    = `/jsonapi/openkb_space/openkb_space?${params.getQueryString({ encodeValuesOnly: true })}`
  while (path) {
    const page: SpacePage = await drupalFetch<SpacePage>(event, path)
    resources.push(...(page.data ?? []))
    path = page.data?.length ? jsonApiNextPath(page) : null
  }

  const spaces = resources.map(toSummary)
  if (!options.withAccess) return spaces

  const access = await spaceAccessBySlug(event)
  return spaces.map(space => ({
    ...space,
    canManage: holds(access.get(space.slug)?.access, 'manage'),
    canWrite: holds(access.get(space.slug)?.access, 'write'),
  }))
}

/** Whether an access level from the map reaches `minimum`. Absent reads as "no". */
function holds(access: string | undefined, minimum: 'write' | 'manage'): boolean {
  return access !== undefined && atLeast(access as 'read' | 'write' | 'manage', minimum)
}

/**
 * Whether the session may administer this space.
 *
 * Read off the access map, which is Drupal's own answer to the question the
 * JSON:API PATCH will re-ask — computed from the same access policy that
 * extends management to a space's managers. A map that did not arrive answers
 * "no" for every space: never a page error, and never a drag handle on a tree
 * Drupal would refuse to save.
 */
export async function canManageSpace(event: H3Event, slug: string): Promise<boolean> {
  const access = await spaceAccessBySlug(event)
  return holds(access.get(slug)?.access, 'manage')
}

/**
 * Whether the session may create a space.
 *
 * Off the permissions Drupal reports for the session
 * ({@link sitePermissions}), {@link SPACE_CREATE_PERMISSION} among them —
 * shared with the rest of the chrome's answers, so the read happens once. A
 * request carrying no auth carrier is answered "no" without asking: the
 * resource is granted to authenticated roles only, so an anonymous read is a
 * denial Drupal logs.
 */
export async function canCreateSpace(event: H3Event): Promise<boolean> {
  if (Object.keys(forwardedAuthHeaders(event)).length === 0) return false
  return (await sitePermissions(event))[SPACE_CREATE_PERMISSION] === true
}

/** What a creation surface supplies for a new space. */
export interface NewSpace {
  name: string
  description?: string
  readAccess?: KbSpaceReadAccess
  moderation?: boolean
}

/**
 * Creates one space via a plain JSON:API POST; answers its id and URL slug.
 *
 * The entity does the work: it gates the create, refuses a name whose URL is
 * taken, and puts the creator on the managers roster. Read access and
 * moderation default to members-only + moderated, so each is sent only when
 * set. The slug comes back off the saved space — its path alias — and is what
 * to navigate to; the space page loads its own roster.
 */
export async function createSpace(event: H3Event, space: NewSpace): Promise<{ id: string, slug: string }> {
  const attributes: Record<string, unknown> = { label: space.name }
  if (space.description) attributes.description = space.description
  if (space.readAccess) attributes.read_access = space.readAccess
  // `false` is a real choice — compare against undefined, not truthiness.
  if (space.moderation !== undefined) attributes.field_moderation = space.moderation

  const json = await drupalFetch<{ data?: SpaceResource }>(event, '/jsonapi/openkb_space/openkb_space', {
    method: 'POST',
    body: JSON.stringify({ data: { type: SPACE_TYPE, attributes } }),
  })
  const uuid = json.data?.id
  const slug = spaceSlug(json.data?.attributes?.path?.alias ?? '')
  if (!uuid || !slug) {
    // A 2xx without the space is a broken upstream contract, not a user error.
    throw createError({ statusCode: 503, statusMessage: UPSTREAM_UNAVAILABLE })
  }
  return { id: uuid, slug }
}

/** Loads one space by UUID, roster included. */
export async function loadSpace(event: H3Event, uuid: string): Promise<KbSpaceDetail> {
  const params = new DrupalJsonApiParams()
    .addFields(SPACE_TYPE, SPACE_FIELDS)
    .addFields('user--user', USER_FIELDS)
    .addInclude(['managers', 'members', 'viewers'])
  const json = await drupalFetch<{ data: SpaceResource, included?: UserResource[] }>(
    event,
    `/jsonapi/openkb_space/openkb_space/${uuid}?${params.getQueryString({ encodeValuesOnly: true })}`,
  )
  const users = indexUsers(json.included)
  const summary = toSummary(json.data)
  return {
    ...summary,
    managers: rosterOf(json.data, 'managers', users),
    members: rosterOf(json.data, 'members', users),
    viewers: rosterOf(json.data, 'viewers', users),
    canManage: await canManageSpace(event, summary.slug),
  }
}

/** Resolves a space's URL slug to its space, or null. */
export async function findSpaceBySlug(event: H3Event, slug: string): Promise<SpaceSummary | null> {
  const spaces = await listSpaces(event)
  return spaces.find(space => space.slug === slug) ?? null
}

/** What a space settings write may change — roster, description, policies. */
export interface SpaceSettings {
  managers?: string[]
  members?: string[]
  viewers?: string[]
  description?: string
  readAccess?: KbSpaceReadAccess
  moderation?: boolean
}

/**
 * A space UUID from whatever a caller addressed the space with.
 *
 * Both forms come from real invocation contexts: the space landing page and the
 * sidebar know their slug, a space picker knows the UUID. A UUID passes through
 * unresolved — Drupal rejects one that is not a space — and anything else is
 * looked up as a slug, so an unknown space fails here with a 404 instead of as a
 * validation error on the write.
 */
export async function resolveSpaceId(event: H3Event, space: string): Promise<string> {
  if (UUID.test(space)) return space
  const found = await findSpaceBySlug(event, space)
  if (!found) throw createError({ statusCode: 404, statusMessage: 'Space not found' })
  return found.id
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Replaces a space's page tree and returns the tree as stored.
 *
 * Whole-tree is the point: one write per drag, touching no page. `expect` is
 * the tree the caller believes the field holds, and Drupal refuses the write
 * outright when it no longer does — so a drag that lost a race is reported
 * rather than carrying away the winner's reorganisation.
 *
 * Nothing is validated here: the shape contract (ids unique, every id an
 * page of this space) is a constraint on the `outline` field, so a bad tree
 * comes back as Drupal's 422 whichever door it arrived through.
 */
export async function writeOutline(
  event: H3Event,
  id: number,
  outline: Outline,
  expect: Outline,
): Promise<Outline> {
  const json = await drupalFetch<{ outline?: unknown }>(
    event,
    `/openkb/space/${id}/outline`,
    {
      method: 'PUT',
      // The outline payload is not a JSON:API document, so it does not claim
      // the media type drupalFetch defaults to.
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outline, expect }),
    },
  )
  return sanitiseOutline(Array.isArray(json?.outline) ? json.outline : [])
}

/**
 * The JSON:API PATCH body for a space settings write.
 *
 * Roster fields are replaced whole, which is last-write-wins: two managers
 * editing the same space concurrently overwrite each other. At team scale that
 * is the accepted trade — the alternative is per-reference add/remove semantics
 * JSON:API does not offer for multi-value fields. A key left out of `settings`
 * is left out of the body, so a settings write never rewrites the roster.
 */
export function spacePatchBody(uuid: string, settings: SpaceSettings) {
  const refs = (ids: string[]) => ({ data: ids.map(id => ({ type: 'user--user', id })) })
  const relationships: Record<string, unknown> = {}
  if (settings.managers) relationships.managers = refs(settings.managers)
  if (settings.members) relationships.members = refs(settings.members)
  if (settings.viewers) relationships.viewers = refs(settings.viewers)

  const attributes: Record<string, unknown> = {}
  // An emptied description is a change — compare against undefined.
  if (settings.description !== undefined) attributes.description = settings.description
  if (settings.readAccess) attributes.read_access = settings.readAccess
  // Compared against undefined, not truthiness: `false` is the whole point of
  // the moderation flag and must reach Drupal.
  if (settings.moderation !== undefined) attributes.field_moderation = settings.moderation

  const data: Record<string, unknown> = { type: SPACE_TYPE, id: uuid }
  if (Object.keys(attributes).length) data.attributes = attributes
  if (Object.keys(relationships).length) data.relationships = relationships

  return { data }
}

/** Writes a space's settings and returns the space as it now stands. */
export async function writeSpace(
  event: H3Event,
  uuid: string,
  settings: SpaceSettings,
): Promise<KbSpaceDetail> {
  await drupalFetch(event, `/jsonapi/openkb_space/openkb_space/${uuid}`, {
    method: 'PATCH',
    body: JSON.stringify(spacePatchBody(uuid, settings)),
  })
  return loadSpace(event, uuid)
}
