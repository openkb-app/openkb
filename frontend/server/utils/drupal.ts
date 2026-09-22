import type { H3Event } from 'h3'
import { createError, getHeader } from 'h3'
import { SPACE_TYPE, type KbSpace } from '#shared/utils/kb-spaces'
import type { InlineCommentRecord } from '#shared/block-comments'
import { fetchUpstream, upstreamError, UPSTREAM_UNAVAILABLE } from './upstream'
import { forwardedAuthHeaders } from './actor'
import { splitTitleHeading } from './title-heading'
import {
  fieldSpecs,
  type FieldSpec,
  type FrontmatterSchema,
} from './entity-fields'

/**
 * Server-to-server bridge to Drupal JSON:API.
 *
 * Auth model: forwards the incoming request's auth carrier — an
 * `Authorization: Bearer` agent token, or the user's Drupal session cookie
 * (see server/utils/actor.ts for the one rule). The Lupus Decoupled pattern
 * is that users authenticate through the frontend (lupus_decoupled_user_form
 * CE variants of user.login etc.), which results in a session cookie scoped
 * to the parent host (SESSION_COOKIE_DOMAIN=.openkb-dev-project.localdev.space),
 * so the browser sends it to both the Nuxt server and (when needed) Drupal.
 * Agents send a Bearer token instead (a simple_oauth token with an agent
 * scope). Either way the carrier is forwarded so Drupal sees the acting account
 * and enforces per-role/per-scope permissions — the Nuxt layer grants nothing.
 *
 * Cookie-authed writes also need Drupal's X-CSRF-Token (fetched lazily per
 * session); token auth is not cookie-based and needs none.
 *
 * Body writes send the value alone. The text format is Drupal's answer — the
 * body field's configured one, filled in on presave — so nothing here names
 * a format.
 */

export function drupalBaseUrl(): string {
  const config = useRuntimeConfig()
  return (config.drupalBaseUrl as string).replace(/\/$/, '')
}

/**
 * Base URL for browser-facing links and asset URLs. The server-side
 * `runtimeConfig.drupalBaseUrl` may point at a container-internal route;
 * `public.drupalBaseUrl` is what the browser can actually reach (see
 * docker/frontend/entrypoint.sh for the env mapping).
 */
export function publicDrupalBaseUrl(): string {
  const pub = useRuntimeConfig().public.drupalBaseUrl as string | undefined
  return (pub || drupalBaseUrl()).replace(/\/$/, '')
}

async function fetchCsrfToken(cookie: string): Promise<string | null> {
  const res = await fetchUpstream(`${drupalBaseUrl()}/session/token`, {
    headers: { Cookie: cookie },
  })
  if (!res.ok) return null
  return (await res.text()).trim()
}

/**
 * Auth-carrying core of {@link drupalFetch}: `auth` is the forwarded carrier
 * ({ Authorization } or { Cookie }, empty for anonymous). Request handlers use
 * the event wrapper below; callers without an H3Event — the headless commit
 * service driven by auto-checkpoint triggers and by agent sessions
 * (server/utils/commit.ts) — pass this server's own Bearer token, or an
 * agent's. All share one implementation.
 */
export async function drupalFetchWithAuth<T = unknown>(
  auth: Record<string, string>,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const url = `${drupalBaseUrl()}${path}`
  const method = (init.method ?? 'GET').toUpperCase()
  const headers: Record<string, string> = {
    Accept: 'application/vnd.api+json',
    'Content-Type': 'application/vnd.api+json',
    ...auth,
    ...((init.headers as Record<string, string>) ?? {}),
  }

  // CSRF token required for cookie-authed writes (POST/PATCH/DELETE).
  if (method !== 'GET' && method !== 'HEAD' && auth.Cookie) {
    const token = await fetchCsrfToken(auth.Cookie)
    if (token) headers['X-CSRF-Token'] = token
  }

  const res = await fetchUpstream(url, { ...init, headers })
  if (!res.ok) throw await upstreamError(res, `${method} ${path}`)
  if (res.status === 204) return null as T
  return (await res.json()) as T
}

export function drupalFetchWithCookie<T = unknown>(
  cookie: string | undefined,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  return drupalFetchWithAuth<T>(cookie ? { Cookie: cookie } : {}, path, init)
}

/** Forwarded-carrier headers for a raw Bearer token. */
export function bearerAuthHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

export function drupalFetch<T = unknown>(
  event: H3Event,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  return drupalFetchWithAuth<T>(forwardedAuthHeaders(event), path, init)
}

/**
 * The largest page JSON:API will answer with.
 *
 * Core clamps `page[limit]` to `OffsetPage::SIZE_MAX`, a class constant, so
 * asking for more buys nothing: a complete listing follows `next` instead.
 */
export const JSONAPI_PAGE_SIZE = 50

/** One page of a JSON:API collection, as far as paging cares. */
export interface JsonApiPage {
  links?: { next?: { href: string } }
}

/**
 * The path a collection's `next` link answers on, or null at the end.
 *
 * Drupal builds the link from its own base URL, which is not the host the Nuxt
 * server talks to, so only path and query survive. Drupal also answers `next`
 * on the last full page, so callers stop on an empty page too.
 */
export function jsonApiNextPath(page: JsonApiPage): string | null {
  const href = page.links?.next?.href
  if (!href) return null
  try {
    const url = new URL(href)
    return `${url.pathname}${url.search}`
  }
  catch {
    return href.startsWith('/') ? href : null
  }
}

/**
 * The permissions Drupal reports for the calling session.
 *
 * `GET /api/site-info` answers, per account, the permissions
 * `lupus_decoupled_site_info.settings` lists — a plain JSON read, so nothing
 * renders a page and nothing drains the session's message queue into a
 * response nobody displays. Resolved once per request and shared by every
 * consumer.
 *
 * A read that fails answers no permissions, which is the fail-closed answer
 * every caller wants: a control is not drawn, and Drupal still decides the
 * action behind it.
 */
export function sitePermissions(event: H3Event): Promise<Record<string, boolean>> {
  const cached = event.context.okbSitePermissions as Promise<Record<string, boolean>> | undefined
  if (cached) return cached

  const promise = (async (): Promise<Record<string, boolean>> => {
    try {
      const info = await drupalFetch<{ permissions?: Record<string, boolean> }>(
        event,
        '/api/site-info?_format=json',
        { headers: { Accept: 'application/json' } },
      )
      return info.permissions ?? {}
    }
    catch {
      return {}
    }
  })()
  event.context.okbSitePermissions = promise
  return promise
}

/** One kb_page node, as a CE read answers it — not the `.md` / MCP
 *  projection of the same page (server/utils/kb-read.ts). */
export interface KbPageNode {
  /** JSON:API UUID — required for PATCH path. */
  id: string
  /** drupal_internal__nid — used in URLs like /node/<nid>/edit. */
  nid: number
  /**
   * The space-scoped alias (e.g. /team-wiki/getting-started) — the page's
   * one address everywhere: the frontend URL, the `.md` projection, MCP,
   * search. Generated by pathauto on the core `path` field.
   */
  path: string
  title: string
  /** Comark markdown below the title heading — the document every lane reads,
   *  edits and diffs. Read pages render it via the Nuxt comark tree passes;
   *  agents fetch it as-is. */
  body: string
  /** The stored body's leading `# <title>` line, split off here so the title
   *  is a node field everywhere (server/utils/title-heading.ts). Whoever
   *  writes the body back joins it on again. */
  titleHeading: string
  /**
   * Drupal's `changed` timestamp (epoch seconds). Threaded through GET +
   * PATCH so the editor can detect external edits during a live session:
   * the client sends its last-known `changed` on PATCH, the server compares
   * to Drupal's current value, and a mismatch becomes a 409.
   */
  changed: number
  /**
   * Raw `field_block_meta` — the block-provenance sidecar (OKB-67), keyed by
   * the block ids the *body of this same revision* carries. It rides on the
   * page rather than on a lookup of its own precisely so the two can never
   * be read from different revisions: a sidecar paired with a foreign body
   * names ids that body does not have, and the commit's coherence sweep then
   * reports a permanent diff on a document nobody edited.
   */
  blockMeta: string
  /**
   * The page's space — `{ id, name }` of the `field_space` term, or null.
   *
   * Placement rather than content: it is not part of the frontmatter an editor
   * edits (OKB-63), and the surface that reads it here is the move action, which
   * needs to know where the page currently lives.
   */
  space: KbSpace | null
}

/**
 * The `kb_page` CE-API page, as `custom_elements.entity_ce_display
 * .node.kb_page.full` projects it: one prop per exposed field, each
 * frontmatter prop named for its frontmatter key.
 */
interface CeResponse {
  content?: { element?: string, props?: Record<string, unknown> }
  /** Drupal's access answer for this account — an `Edit` task is node.update. */
  local_tasks?: { primary?: Array<{ label?: string }> }
}

/** Prop of a `kb_page` CE page, unwrapped from Drupal's field item shape. */
function ceString(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (raw && typeof raw === 'object') {
    const value = (raw as { value?: unknown }).value
    if (typeof value === 'string') return value
  }
  return ''
}

function ceSpace(raw: unknown): KbSpace | null {
  if (!raw || typeof raw !== 'object') return null
  const { uuid, name } = raw as { uuid?: string, name?: string }
  return uuid ? { id: uuid, name: name ?? '' } : null
}

function mapCePage(props: Record<string, unknown>): KbPageNode {
  const nid = Number(props.nid)
  return {
    id: ceString(props.uuid),
    nid,
    path: ceString(props.path) || `/node/${nid}`,
    title: ceString(props.title),
    ...splitTitleHeading(ceString(props.body)),
    changed: Number(props.changed) || 0,
    blockMeta: ceString(props.blockMeta),
    space: ceSpace(props.space),
  }
}

/**
 * Fetches the CE page at a space-scoped path and maps it to a page.
 *
 * Drupal's router resolves the alias when the CE endpoint is fetched, so one
 * `GET /ce-api/<path>` is the whole read — enforcing view access, so a path the
 * actor may not read answers 404 → `null` here. Any other element (a space
 * landing, the 404 markup) is not a page. The raw props come back beside
 * the page because the `.md` projection reads its frontmatter off them
 * ({@link mapCeFieldValues}). A trailing `.md` is tolerated so a filename works.
 *
 * `canEdit` is the payload's `Edit` local task — Drupal's own update answer for
 * this account, the same signal the editor chrome and the collab gate read.
 */
export async function fetchCePage(
  event: H3Event,
  path: string,
): Promise<CePageRead | null> {
  // A search hit's path is anchored on the section it cites, so the address an
  // agent carries over from one names a block after it.
  const clean = path.replace(/#.*$/, '').replace(/\.md$/, '').replace(/^\/+/, '')
  const cePath = '/ce-api/' + clean.split('/').map(encodeURIComponent).join('/')
  let response: CeResponse
  try {
    response = await drupalFetch<CeResponse>(event, cePath, {
      headers: { Accept: 'application/json' },
    })
  }
  catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return null
    throw err
  }
  return cePageRead(response)
}

/**
 * A `kb_page` read off one CE page.
 *
 * `props` comes back beside the page because the `.md` projection and the
 * collaboration seed read their frontmatter off it ({@link mapCeFieldValues}),
 * against specs the schema endpoint hands out.
 */
export interface CePageRead {
  page: KbPageNode
  props: Record<string, unknown>
  /** Drupal's update answer for this account — the page's `Edit` task. */
  canEdit: boolean
  /**
   * A forward draft exists that this account may read — the page's `Latest
   * version` task. On a working-copy read it also says the body read is that
   * draft.
   */
  hasDraft: boolean
}

/** The task labels a CE response carries, which are Drupal's access answers. */
function ceTasks(response: CeResponse): string[] {
  const tasks = response.local_tasks?.primary
  if (!Array.isArray(tasks)) return []
  return tasks
    .map(task => task?.label)
    .filter((label): label is string => typeof label === 'string')
}

/** The page a CE response carries, or `null` when it is not one. */
function cePageRead(response: CeResponse): CePageRead | null {
  if (response.content?.element !== 'node-kb-page') return null
  const props = response.content.props ?? {}
  const page = mapCePage(props)
  if (!Number.isInteger(page.nid) || page.nid <= 0) return null
  const tasks = ceTasks(response)
  return {
    page,
    props,
    canEdit: tasks.includes('Edit'),
    hasDraft: tasks.includes('Latest version'),
  }
}

/** Reads one CE page and insists it is a page. */
async function fetchCeNodePage(
  auth: Record<string, string>,
  path: string,
): Promise<CePageRead> {
  const response = await drupalFetchWithAuth<CeResponse>(auth, path, {
    headers: { Accept: 'application/json' },
  })
  const read = cePageRead(response)
  if (!read) {
    console.error(`[drupal] not a knowledge-base page: ${path}`)
    throw createError({ statusCode: 404, statusMessage: 'Not a knowledge-base page' })
  }
  return read
}

/**
 * A page's live revision, addressed by nid — one request.
 *
 * The route enforces view access, so Drupal's own refusal is what a caller
 * gets: 403 where the account may not read the page, 404 where the space
 * hides it. Absent and forbidden are different answers here, and each caller
 * decides what to do with each.
 *
 * @see \Drupal\Tests\openkb_space_access\Kernel\CeRevisionReadAccessTest
 */
export function fetchCeNode(
  auth: Record<string, string>,
  nid: number,
): Promise<CePageRead> {
  return fetchCeNodePage(auth, `/ce-api/node/${nid}`)
}

/**
 * The working copy of a page, addressed by nid — one request, or two.
 *
 * The working copy is the newest revision: the forward draft where a
 * checkpoint left one, the live revision otherwise. `hasDraft` carries
 * `/latest`'s own access, so that route is never asked for blind and a reader
 * without the task reads the live revision, which is what they may see. Pass
 * `live` where the caller already holds this nid's live read; one of another
 * page is ignored and the right one read.
 */
export async function fetchCeWorkingCopy(
  auth: Record<string, string>,
  nid: number,
  live?: CePageRead,
): Promise<CePageRead> {
  const published = live?.page.nid === nid ? live : await fetchCeNode(auth, nid)
  if (!published.hasDraft) return published
  const draft = await fetchCeNodePage(auth, `/ce-api/node/${nid}/latest`)
  return { ...draft, canEdit: published.canEdit, hasDraft: true }
}

/**
 * One revision of a page, addressed by nid and revision id.
 *
 * Core's revision route asks for view access on the default revision as well
 * as on the revision itself, so a page whose live revision the account may
 * not read answers here even where JSON:API would serve the revision.
 * `canEdit` is the revision route's own `Edit` task, not the page's.
 */
export async function fetchCeRevision(
  auth: Record<string, string>,
  nid: number,
  vid: number,
): Promise<CePageRead> {
  return fetchCeNodePage(auth, `/ce-api/node/${nid}/revisions/${vid}/view`)
}

/** The page at a space-scoped path, or `null`. @see fetchCePage */
export async function findKbPageByPath(
  event: H3Event,
  path: string,
): Promise<KbPageNode | null> {
  return (await fetchCePage(event, path))?.page ?? null
}

/**
 * Which revision a read resolves to.
 *
 * `kb_page` is moderated (OKB-64), so a published page can carry a
 * *forward draft*: a newer, non-default revision holding work in progress.
 * `default` is the live revision every public surface serves; `working-copy`
 * is the newest revision, which is what every editing surface needs.
 */
export type PageVersion = 'default' | 'working-copy'

/**
 * Extra JSON:API `data` fragment merged onto a kb_page PATCH — the seam
 * OKB-9 step 7's field diff (attributes + relationships) writes through. The
 * body attribute is always set by the caller; extenders add to it.
 */
/**
 * What Drupal did with the sign-offs a checkpoint stated.
 *
 * Every entry names the account that signed off, so a peer reading the relayed
 * answer tells its own sign-off from a colleague's.
 */
export interface ReviewOutcome {
  /** The sign-offs it recorded. */
  approved: Array<{ item: string, step: string, uid: number }>
  /** The sign-offs the review rules turned down, in Drupal's own words. */
  refused: Array<{ item: string, step: string, uid: number, reason: string }>
}

/** A written revision, and Drupal's answer to the sign-offs that rode with it. */
export interface CommittedRevision {
  /** The revision's `changed` — a session's optimistic-concurrency token. */
  changed: number
  /** Null where the checkpoint stated no sign-offs. */
  review: ReviewOutcome | null
}

export interface KbPagePatchExtra {
  attributes?: Record<string, unknown>
  relationships?: Record<string, unknown>
  /** Collab-session directives, read by the commit endpoint only on the
   *  collaboration client's own OAuth connection (ADR 0001). */
  session?: Record<string, unknown>
  /** The working copy's `changed` this payload was assembled against. Drupal
   *  refuses the commit with 409 when the page has moved past it. */
  basedOnChanged?: number
}

/**
 * Raw JSON:API PATCH of the body — the transport of the `/api/node/<nid>`
 * proxy only ([id].patch.ts). Every other write surface commits through
 * {@link commitKbPageWithAuth}; this one still speaks JSON:API, so it
 * fails with 400 on a page that already carries a forward draft (core
 * #2795279). The proxy's own future is part of the publish-action design
 * (OKB-20).
 */
export function patchKbPageWithCookie(
  cookie: string | undefined,
  id: string,
  body: string,
  extra: KbPagePatchExtra = {},
): Promise<number> {
  return patchKbPageWithAuth(cookie ? { Cookie: cookie } : {}, id, body, extra)
}

export async function patchKbPageWithAuth(
  auth: Record<string, string>,
  id: string,
  body: string,
  extra: KbPagePatchExtra = {},
): Promise<number> {
  const result = await drupalFetchWithAuth<{ data?: { attributes?: { changed: string } } }>(
    auth,
    `/jsonapi/node/kb_page/${id}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        data: {
          type: 'node--kb_page',
          id,
          attributes: {
            field_kb_body: { value: body },
            ...(extra.attributes ?? {}),
          },
          ...(extra.relationships ? { relationships: extra.relationships } : {}),
        },
      }),
    },
  )
  const iso = result?.data?.attributes?.changed
  return iso ? Math.floor(new Date(iso).getTime() / 1000) : Math.floor(Date.now() / 1000)
}

export function patchKbPageBody(
  event: H3Event,
  id: string,
  body: string,
  extra: KbPagePatchExtra = {},
): Promise<number> {
  return patchKbPageWithCookie(getHeader(event, 'cookie'), id, body, extra)
}

/**
 * Write one revision through the moderation-aware commit route.
 *
 * Not a JSON:API PATCH: `kb_page` carries forward drafts, and JSON:API
 * refuses every write on an entity whose latest revision is not the default
 * one (core #2795279) — so the second checkpoint of a session would 400. The
 * Drupal-side route (`openkb_collab_api`'s CommitResource) bases each write on
 * the *latest* revision instead, which is also what keeps a partial payload from
 * reverting fields an earlier checkpoint wrote into the working copy.
 *
 * It is core's JSON:API entity resource underneath, so the request payload is
 * the same `{attributes, relationships}` fragment the commit pipeline's
 * extenders already produce and both the written resource and every rejection
 * come back as JSON:API documents — the whole error taxonomy above this line,
 * and every extender below it, is untouched by the transport.
 *
 * `basedOnChanged` rides along as the payload's `based_on_changed`: the
 * revision the caller assembled this write against. Drupal answers 409 and
 * writes nothing when the page has moved past it.
 */
export async function commitKbPageWithAuth(
  auth: Record<string, string>,
  nid: number,
  body: string,
  extra: KbPagePatchExtra = {},
): Promise<CommittedRevision> {
  const result = await drupalFetchWithAuth<{
    data?: { attributes?: { changed: string } }
    meta?: { review?: ReviewOutcome }
  }>(
    auth,
    `/openkb/node/${nid}/commit`,
    {
      method: 'POST',
      // The body is the bare commit fragment, not a JSON:API document, so it
      // does not claim the JSON:API media type drupalFetch defaults to.
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attributes: {
          field_kb_body: { value: body },
          ...(extra.attributes ?? {}),
        },
        ...(extra.relationships ? { relationships: extra.relationships } : {}),
        ...(extra.session ? { session: extra.session } : {}),
        ...(extra.basedOnChanged ? { based_on_changed: extra.basedOnChanged } : {}),
      }),
    },
  )
  // Drupal answers with the written revision, so the caller can advance its
  // optimistic-concurrency token (`changed`) without an extra GET.
  const iso = result?.data?.attributes?.changed
  return {
    changed: iso ? Math.floor(new Date(iso).getTime() / 1000) : Math.floor(Date.now() / 1000),
    review: result?.meta?.review ?? null,
  }
}

/** What a creation surface supplies for a new page. */
export interface NewKbPage {
  title: string
  /** UUID of the space the page is created in. */
  spaceId: string
  /** Seed body. Comark markdown. */
  body: string
  /** `field_type` value the creation dialog picked, if any. */
  type?: string
}

/** A created page, as the creation surface needs it to navigate. */
export interface CreatedKbPage {
  nid: number
  uuid: string
  title: string
  /** Path alias pathauto generated — where the frontend serves the new page. */
  path: string
}

/**
 * Creates one page, in the space it is being created from.
 *
 * A plain JSON:API POST, unlike every *update* on a kb_page (which goes
 * through the commit route because forward drafts exist): a brand-new page
 * has no revisions to reconcile, so core's own create path — with its field
 * access checks, its validation and its 422 documents — is exactly right.
 *
 * Two things are decided here rather than asked of the author:
 *   - `moderation_state: draft`, so a new page starts as a draft and is
 *     published deliberately (the OKB-64 model). It is also its own default
 *     revision, which is what makes the editor able to open it at all.
 *   - a seeded body (the title heading), because `field_kb_body` is required
 *     and an empty document would fail validation before the author ever sees
 *     the editor.
 *
 * The alias is not written here: pathauto generates `<space-slug>/<title>` (and
 * uniquifies it) on save. It is not on the POST response — pathauto stamps it
 * after the entity saves — so the created path is read back with a by-nid fetch.
 *
 * The space rides as a relationship: it is context, not frontmatter (OKB-63).
 */
export async function createKbPage(
  event: H3Event,
  page: NewKbPage,
): Promise<CreatedKbPage> {
  const result = await drupalFetch<{
    data?: {
      id: string
      attributes?: {
        drupal_internal__nid?: number
        title?: string
      }
    }
  }>(event, '/jsonapi/node/kb_page', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        type: 'node--kb_page',
        attributes: {
          title: page.title,
          field_kb_body: { value: page.body },
          moderation_state: 'draft',
          ...(page.type ? { field_type: page.type } : {}),
        },
        relationships: {
          field_space: {
            data: { type: SPACE_TYPE, id: page.spaceId },
          },
        },
      },
    }),
  })

  const created = result?.data
  const nid = created?.attributes?.drupal_internal__nid
  if (!created?.id || !nid) {
    // A 2xx without the node is a broken upstream contract, not a user error.
    throw createError({ statusCode: 503, statusMessage: UPSTREAM_UNAVAILABLE })
  }
  // Read the pathauto-generated alias back — it is not on the create response.
  // A readback that fails is not worth losing the page over: the node route
  // serves it until the next read resolves the alias.
  const persisted = await fetchCeNode(forwardedAuthHeaders(event), nid).catch(() => null)
  return {
    nid,
    uuid: created.id,
    title: created.attributes?.title ?? page.title,
    path: persisted?.page.path ?? `/node/${nid}`,
  }
}

/**
 * Moves a page to another space.
 *
 * Not a JSON:API PATCH and not a commit: placement has to reach the published
 * revision every listing reads *and* the forward draft that becomes published
 * next, which is what `POST /openkb/node/<nid>/space` exists for. See
 * \Drupal\openkb_jsonapi\Controller\PageSpaceResource for why neither of the
 * other two write paths can express it.
 */
export function moveKbPageToSpace(
  event: H3Event,
  nid: number,
  spaceId: string,
): Promise<{ nid: number, space: { id: string, name: string } }> {
  return drupalFetch(event, `/openkb/node/${nid}/space`, {
    method: 'POST',
    // The move payload is not a JSON:API document, so it does not claim the
    // media type drupalFetch defaults to.
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ space: spaceId }),
  })
}

/** What Drupal answered when asked whether this session may delete a node. */
export interface DeleteAccessProbe {
  /** Drupal grants the delete. */
  allowed: boolean
  /** True only when Drupal says the node does not exist. */
  missing: boolean
}

/**
 * Whether the session may delete this node.
 *
 * Asks Drupal rather than inferring it from the edit signal: delete access is
 * its own permission, and with editorial moderation an editor who may update an
 * page is not necessarily allowed to remove it. The delete-form route runs
 * the same access check the JSON:API DELETE will run, so the answer is
 * Drupal's, and it is asked *before* the collab session is stood down — a
 * session torn down for a request that then 403s would be a real cost to every
 * peer. A probe failure answers "no": refusing a delete on a broken probe is
 * the safe direction.
 *
 * The route's own 404 is reported separately, because it is the only reliable
 * existence answer the caller has: a JSON:API lookup returns nothing both for a
 * node that is absent and for one the session may not read, and reporting
 * "not found" to someone who is merely not allowed is the wrong answer.
 */
export async function probeDeleteAccess(event: H3Event, nid: number): Promise<DeleteAccessProbe> {
  const auth = forwardedAuthHeaders(event)
  if (Object.keys(auth).length === 0) return { allowed: false, missing: false }
  try {
    const res = await fetchUpstream(`${drupalBaseUrl()}/node/${nid}/delete`, {
      method: 'HEAD',
      headers: { ...auth, Accept: 'text/html' },
    })
    return { allowed: res.ok, missing: res.status === 404 }
  }
  catch (e) {
    console.error(`[drupal] delete-access probe for node ${nid} failed:`, (e as Error).message)
    return { allowed: false, missing: false }
  }
}

/** Attempts a losing DELETE gets, and the base backoff between them. */
const DELETE_ATTEMPTS = 3
const DELETE_BACKOFF_MS = 300

/** MariaDB's "retry this transaction" answer, as it reaches us through Drupal. */
function isDeadlock(body: string): boolean {
  return body.includes('SQLSTATE[40001]') || body.includes('1213 Deadlock found')
}

/**
 * Deletes a kb_page, retrying only on an InnoDB deadlock.
 *
 * The collab session is settled before this runs, so the known concurrent
 * writer is gone — but a node is also written by anything else holding it
 * (another user's JSON:API call, a queue worker), and a deadlock is the
 * database explicitly asking for a retry rather than a verdict on the request.
 * Every other non-2xx surfaces through {@link upstreamError} unchanged.
 *
 * A 404 on a retry means an earlier attempt committed the delete and only then
 * lost the lock race — the page is gone, which is what the caller wanted.
 */
export async function deleteKbPageWithAuth(
  auth: Record<string, string>,
  id: string,
): Promise<void> {
  const path = `/jsonapi/node/kb_page/${id}`
  const headers: Record<string, string> = { Accept: 'application/vnd.api+json', ...auth }
  if (auth.Cookie) {
    const token = await fetchCsrfToken(auth.Cookie)
    if (token) headers['X-CSRF-Token'] = token
  }

  for (let attempt = 1; ; attempt++) {
    const res = await fetchUpstream(`${drupalBaseUrl()}${path}`, { method: 'DELETE', headers })
    if (res.ok) return
    if (attempt > 1 && res.status === 404) return

    const body = await res.text().catch(() => '')
    if (attempt === DELETE_ATTEMPTS || !isDeadlock(body)) {
      throw await upstreamError(res, `DELETE ${path}`, body)
    }
    console.warn(`[drupal] DELETE ${path} deadlocked (attempt ${attempt}), retrying`)
    await new Promise(r => setTimeout(r, DELETE_BACKOFF_MS * attempt))
  }
}

export function deleteKbPage(event: H3Event, id: string): Promise<void> {
  return deleteKbPageWithAuth(forwardedAuthHeaders(event), id)
}

/**
 * The exposed frontmatter fields, authed as the request's actor. Reuses the
 * OKB-46 exposure contract: `GET /openkb/schema` derived from the `frontmatter`
 * form display, read through {@link fieldSpecs}. The `.md` projection and the
 * collab session share this one contract, so a field placed/removed in that
 * form mode changes both with no code change.
 */
export async function fetchFrontmatterSpecs(event: H3Event): Promise<FieldSpec[]> {
  return fieldSpecs(await fetchFrontmatterSchema(event))
}

/**
 * The raw frontmatter JSON Schema (`GET /openkb/schema`), authed as the
 * request's actor. {@link fetchFrontmatterSpecs} reduces it to {@link FieldSpec}s
 * for projection; the MCP `getPageForEditing` tool embeds it verbatim as its
 * output
 * schema so the tool contract tracks the form display with no hardcoded fields.
 */
export function fetchFrontmatterSchema(event: H3Event): Promise<FrontmatterSchema> {
  // The schema endpoint speaks plain JSON, not JSON:API — override the Accept
  // default drupalFetch sends to the JSON:API base.
  return drupalFetch<FrontmatterSchema>(event, '/openkb/schema', {
    headers: { Accept: 'application/json' },
  })
}

/**
 * The stored inline comments of one entity translation.
 *
 * Plain JSON, not JSON:API: messages are internal entities, so they reach
 * nothing generic — `/api/inline-comments` is their only surface.
 */
export function fetchInlineComments(
  auth: Record<string, string>,
  entityType: string,
  entityId: number | string,
): Promise<{ messages: InlineCommentRecord[] }> {
  const query = new URLSearchParams({ entity_type: entityType, entity_id: String(entityId) })
  return drupalFetchWithAuth<{ messages: InlineCommentRecord[] }>(
    auth,
    `/api/inline-comments?${query}`,
    { headers: { Accept: 'application/json' } },
  )
}

/**
 * Makes the stored messages of one entity translation the ones stated.
 *
 * A full set, every time: coordinates that are not stated are dropped. Each
 * message names its own author — the collaboration server is the only party
 * that witnessed who typed which, and the endpoint takes every caller at its
 * word about that.
 *
 * @returns how many messages the call stored and dropped.
 */
export async function putInlineComments(
  auth: Record<string, string>,
  entityType: string,
  entityId: number | string,
  messages: readonly InlineCommentRecord[],
): Promise<{ stored: number, dropped: number }> {
  const answer = await drupalFetchWithAuth<{ stored?: number, dropped?: number }>(
    auth,
    '/api/inline-comments',
    {
      method: 'PUT',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_type: entityType, entity_id: String(entityId), messages }),
    },
  )
  return { stored: Number(answer?.stored ?? 0), dropped: Number(answer?.dropped ?? 0) }
}
