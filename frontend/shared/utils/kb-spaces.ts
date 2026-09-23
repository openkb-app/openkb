import { REVIEW_STEPS, type ReviewStep } from '#shared/page-blocks'

/**
 * KB spaces: the client-side shape of the `field_space` target.
 *
 * A space's URL is its path alias, which Drupal puts on every payload that
 * carries a space — nothing here derives one from the name. Grouping the
 * page list into per-space navigation lives in `kb-outline.ts`, which needs
 * the stored tree as well as the list.
 */

/** The slug in a space's path alias: the alias without its leading slash. */
export function spaceSlug(path: string): string {
  return path.replace(/^\//, '')
}

/** JSON:API resource type of a space — the type name every write names. */
export const SPACE_TYPE = 'openkb_space--openkb_space'

/**
 * Permission that governs creating a space.
 *
 * `openkb_recipe_core` lists it under `lupus_decoupled_site_info.settings`, so
 * `/api/site-info` answers whether the session holds it and the add-space CTA
 * is drawn on that. Drupal still enforces the write.
 */
export const SPACE_CREATE_PERMISSION = 'create openkb_space'

/**
 * The site-wide half of who may create a page — core's per-bundle one.
 *
 * `openkb_recipe_core` lists it under `lupus_decoupled_site_info.settings`
 * beside {@link SPACE_CREATE_PERMISSION}, so `/api/site-info` answers whether
 * the session holds it. It is only half the answer: a page also lands in a
 * space, and that takes write access there ({@link canCreatePageIn}).
 */
export const PAGE_CREATE_PERMISSION = 'create kb_page content'

export interface KbSpace {
  id: string
  name: string
}

export interface KbPageListItem {
  /** Page UUID — how the space outline (OKB-87) names this page. */
  id: string
  title: string
  path: string
  space: KbSpace | null
  /** Node `changed` as epoch milliseconds; 0 when Drupal sent no timestamp. */
  changed: number
}

/** A user on a space roster, as the members UI renders and PATCHes them. */
export interface KbSpaceMember {
  /** User UUID — the JSON:API relationship identifier the roster PATCH writes. */
  id: string
  uid: number
  name: string
}

/**
 * Who may read a space.
 *
 * `members_only` (the default for a new space) means the roster — managers,
 * members and viewers — and nobody else: everyone else sees neither the space
 * nor its pages anywhere. `all_users` opens reading to every signed-in user.
 * Writing takes a manager or member either way.
 */
export type KbSpaceReadAccess = 'members_only' | 'all_users'

/**
 * The space as a kb_page page response carries it.
 *
 * The `full` CE display renders `field_space` through the space's own CE
 * display (`entity_ce_render`), so `content.props.space` is the space object
 * itself — no second request, no id to resolve. `id` is the entity id as
 * Drupal serialised it, beside the `uuid`.
 */
export interface KbSpaceCeProp {
  uuid: string
  id: number | string
  name: string
  /** The space's path alias: its own URL. */
  path: string
  readAccess: KbSpaceReadAccess
  /**
   * Whether edits here go through review — the peer step, and the four-eyes
   * rule with it. Off is wiki-style: anyone on the roster publishes.
   */
  moderation?: boolean
  /** Whether agent-written blocks need a human sign-off before publishing. */
  agentReview?: boolean
}

/**
 * The review steps this space enforces — the client-side reading of
 * \Drupal\openkb_workflow\ReviewPolicy, for the surfaces that have the space
 * but not the moderation status.
 *
 * The read page is one: its byline names what a block still owes, and a reader
 * cannot fetch the status document (it sits behind node.update). So the space's
 * two policy flags ride the page payload and the answer is derived here,
 * from the same two knobs Drupal derives it from.
 *
 * Fail-closed, exactly like `enforcedSteps(null)`: a payload that does not
 * carry the flags reports both steps rather than quietly reporting none.
 *
 * Reported in {@link REVIEW_STEPS} order on every path, so the fall-closed
 * answer and a derived one are the same list in the same order.
 */
export function spaceReviewSteps(space: KbSpaceCeProp | null | undefined): readonly ReviewStep[] {
  if (!space || space.moderation === undefined || space.agentReview === undefined) {
    return REVIEW_STEPS
  }
  const enforced = { peer: space.moderation, agent: space.agentReview }
  return REVIEW_STEPS.filter(step => enforced[step])
}

/** A space without its roster, as `GET /api/spaces` lists them. */
export interface KbSpaceSummary extends KbSpace {
  /**
   * Entity id — the `id` a kb_page's `space` CE prop carries, and what the
   * outline endpoint is addressed by. Named apart because `id` on this shape
   * is the UUID every other frontend surface addresses a space with.
   */
  internalId: number
  slug: string
  description: string
  readAccess: KbSpaceReadAccess
  /**
   * Whether edits here go through review.
   *
   * On (the default) asks for a peer sign-off and brings the four-eyes rule.
   * Off is wiki-style: anyone on the roster publishes. Saving writes a draft
   * either way.
   */
  moderation: boolean
  /**
   * Whether a block an agent wrote needs a human sign-off before the page can
   * be published. On (the default) holds in a wiki space too.
   */
  agentReview: boolean
}

/**
 * Whether the "new page" CTA is drawn.
 *
 * Both halves of Drupal's own rule, which
 * `openkb_space_access_entity_field_access()` enforces on `field_space`:
 * `create kb_page content` site-wide, and write access in the space the
 * page would land in. Either half missing is a dialog that can only be
 * refused.
 *
 * `slug` is the space in context, `null` where none is (home, search): there
 * the dialog asks which space to create in, so the CTA belongs where at least
 * one space can be chosen.
 */
export function canCreatePageIn(
  spaces: Array<{ slug: string, canWrite?: boolean }>,
  slug: string | null,
  holdsPageCreate: boolean,
): boolean {
  if (!holdsPageCreate) return false
  if (slug === null) return spaces.some(space => space.canWrite === true)
  return spaces.find(space => space.slug === slug)?.canWrite === true
}

/** One space with its roster, as `GET /api/spaces/<slug>` answers it. */
export interface KbSpaceDetail extends KbSpaceSummary {
  managers: KbSpaceMember[]
  members: KbSpaceMember[]
  viewers: KbSpaceMember[]
  /**
   * Whether the acting session may manage the space — write its roster and its
   * settings. Held by a space's managers, not its members.
   */
  canManage: boolean
}

/**
 * The three roster ranks a space membership can carry.
 *
 * `manager` manages the space and writes; `member` writes its content;
 * `viewer` reads only. A user sits on exactly one roster.
 */
export type KbSpaceRole = 'manager' | 'member' | 'viewer'

/**
 * The most recently changed pages, newest first.
 *
 * Pages Drupal gave no timestamp for sort last rather than to the top — an
 * unknown edit date is not a recent edit. Ordering happens here rather than in
 * the query because `/api/kb` is shared with the sidebar, which wants creation
 * order.
 */
export function recentlyUpdated(pages: KbPageListItem[], limit: number): KbPageListItem[] {
  return [...pages]
    .sort((a, b) => (b.changed || 0) - (a.changed || 0))
    .slice(0, limit)
}

/**
 * A space description as one line of plain text.
 *
 * Card blurbs want one line, and stripping any markup that reached the field
 * beats rendering it into a grid cell that has no room for it.
 */
export function descriptionText(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Page count per space UUID, for the space cards on the home page. */
export function pageCountsBySpace(pages: KbPageListItem[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const page of pages) {
    if (!page.space) continue
    counts.set(page.space.id, (counts.get(page.space.id) ?? 0) + 1)
  }
  return counts
}

/**
 * The two characters a space's square avatar shows: the initials of a
 * multi-word name ("Product & Design" is PD — a word starting with neither a
 * letter nor a digit names nothing), else the first two letters of the one
 * word. Spaces carry no icon or colour field, so the chrome derives both from
 * what a space does have: its name for the characters, its entity id for a
 * stable colour (below).
 */
export function spaceInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(word => /^[\p{L}\p{N}]/u.test(word))
  if (!words.length) return '?'
  const letters = words.length > 1 ? words[0]![0]! + words[1]![0]! : words[0]!.slice(0, 2)
  return letters.toUpperCase()
}

/**
 * Fixed palette for space avatars, indexed by entity id so a space keeps the
 * same colour everywhere and across reloads. Two constraints on an entry:
 *
 * - It carries the initial in white, so it stays dark enough to clear 4.5:1.
 * - It carries no retired accent, so the brand sweep in
 *   `brand-theme.spec.ts` never meets one here.
 */
const SPACE_COLORS = ['#2563eb', '#047857', '#0e7490', '#db2777', '#475569', '#a16207']

export function spaceColor(id: number): string {
  return SPACE_COLORS[Math.abs(id) % SPACE_COLORS.length]!
}

