import { createError, type H3Event } from 'h3'
import {
  fetchCePage,
  fetchCeWorkingCopy,
  fetchFrontmatterSpecs,
  fetchInlineComments,
  type PageVersion,
  type CePageRead,
} from './drupal'
import { forwardedAuthHeaders } from './actor'
import { asCollabServer, collabIdentityConfigured } from './collab-identity'
import { mapCeFieldValues, type FieldSpec, type FieldValues } from './entity-fields'
import { projectFields, projectMarkdown } from './frontmatter'
import { liveContent, liveThreads } from './session-read'
import { threadsOfRecords } from './collab-comments'
import { blockVersions } from './block-versions'
import { decodePageEntities } from './comark-entities'
import { serializeCommitJSON, type ProseMirrorJSON } from './commit'
import { parseMarkdownToDoc } from '../../app/comark/markdown-engine'
import { fetchModerationStatus } from './moderation'
import { blockers, parseBlockMeta } from '#shared/page-blocks'
import type { CommentThread } from '#shared/block-comments'
import { canPublishNow, enforcedSteps, type ModerationStatus } from '#shared/utils/moderation'

/**
 * Read-only knowledge-base access, shared by the `.md` server route and the
 * MCP read tool (server/utils/mcp-tools/get-page-for-editing.ts).
 *
 * There is one code path per read: the `.md` GET endpoint and the MCP tool
 * route through the functions here, so an agent reading a page over MCP sees
 * exactly what the HTTP endpoint serves — same projection, same upstream, same
 * actor-scoped auth (Drupal enforces everything; the request's Bearer token or
 * cookie is forwarded unchanged). Search is not here: it does not go through
 * Drupal at all (server/utils/kb-search.ts).
 */

/**
 * A knowledge-base page in the shapes the `.md` route and MCP
 * `getPageForEditing` need.
 */
export interface KbPage {
  /** The space-scoped alias this page is addressed by (`/team-wiki/x`). */
  path: string
  title: string
  /** Exposed frontmatter fields, in form-display order (OKB-49 projection). */
  frontmatter: Record<string, unknown>
  /**
   * The whole page in the `.md` wire format: a YAML frontmatter block above
   * the canonical comark/MDC body. The one carrier of the body — a reader
   * that wants the body alone strips the block.
   *
   * The body is the one a write of this page would hold, not the stored
   * bytes — see {@link bodyForms}.
   */
  markdown: string
  /**
   * Block id → the block's version, for `updateBlocks` to send back as
   * `expect`. Derived from the body, never stored — see
   * server/utils/block-versions.ts.
   */
  versions: Record<string, string>
  /**
   * Where the page stands editorially, for the account reading it. Absent
   * when {@link KbPageOptions.withStatus} was not asked for, when the reader
   * may not edit the page, or when the status read failed.
   */
  status?: PageStatus
  /**
   * The conversations open about this page's blocks, resolved ones
   * included — the caller decides which of them to serve. Only a working-copy
   * read carries them, and that read is the editors' (ADR 0006).
   */
  comments?: CommentThread[]
}

/**
 * The editorial standing of one page, as a client can state it rather than
 * infer it (OKB-173).
 *
 * Answered from Drupal's own moderation read, so `can_publish` is *this*
 * account's answer and not a global one. The keys are the wire's, not the
 * status document's — this is the shape the MCP `getPageForEditing` tool
 * declares.
 */
export interface PageStatus {
  /** A forward draft sits on top of the published revision. */
  draft_exists: boolean
  /**
   * How many blocks of the revision being read still owe a review step the
   * page's space enforces.
   */
  blocks_pending: number
  /**
   * This account may publish the working copy: it holds the transition, there
   * is something to publish, and the review gate would not refuse it.
   */
  can_publish: boolean
}

export interface KbPageOptions {
  /**
   * Which revision to project. `'default'` (the default) is the published
   * resource `GET /api/kb/<space>/<slug>.md` serves; `'working-copy'` is the draft
   * subresource's, i.e. the forward draft when one exists and the published
   * content when none does.
   */
  version?: PageVersion
  /**
   * Also report {@link PageStatus}. It costs the moderation read, so only the
   * surfaces that answer editorial questions ask for it.
   */
  withStatus?: boolean
  /**
   * Also report the block conversations, on a working-copy read. Free while a
   * session is open — the document already holds them — and one Drupal read
   * otherwise.
   */
  withComments?: boolean
}

/**
 * Resolves a page by its space-scoped path and projects it. Returns `null` when
 * no page lives at that path (the caller maps it to a 404 / tool error). A
 * trailing `.md` on the path is tolerated so the same value works as a filename.
 *
 * Both revisions are the CE page itself: `custom_elements.entity_ce_display
 * .node.kb_page.full` carries the body and every frontmatter field, so one
 * Drupal request answers each (the schema fetch behind
 * {@link fetchFrontmatterSpecs} is the exposure contract, not the page).
 *
 * The working copy is served to the accounts that may write the page: it is
 * where an edit starts, and the surfaces asking for it are the editing ones.
 * A caller without the `Edit` task is refused with a 403 — never the published
 * body under a draft address. An editor whose page carries no forward draft
 * (or who may not see one) is served the revision they may read, which is the
 * one their write would start from.
 *
 * The working copy costs a second request only where the page says a forward
 * draft is there to read ({@link fetchCeWorkingCopy}); on a page carrying
 * none, the page just read is the working copy.
 */
export async function getKbPage(
  event: H3Event,
  path: string,
  options: KbPageOptions = {},
): Promise<KbPage | null> {
  const found = await fetchCePage(event, path.replace(/\.md$/, ''))
  if (!found) return null
  const { page, props, canEdit } = found
  const specs = await fetchFrontmatterSpecs(event)

  if (options.version !== 'working-copy') {
    return project(
      specs,
      page.path,
      page.title,
      page.body,
      mapCeFieldValues(specs, props),
      await pageStatus(event, options, found, page.blockMeta),
    )
  }

  if (!canEdit) {
    throw createError({ statusCode: 403, statusMessage: 'Not allowed to read the working copy' })
  }

  const draft = await fetchCeWorkingCopy(forwardedAuthHeaders(event), page.nid, found)
  const values = mapCeFieldValues(specs, draft.props)

  // A draft read answers with the live session when one is open — see
  // ./session-read. The published read never does: what is live is by
  // definition uncommitted, so it cannot be part of the published resource.
  const live = await liveContent(page.nid, specs)
  return project(
    specs,
    page.path,
    draft.page.title,
    live?.body ?? draft.page.body,
    live ? { ...values, ...live.fields } : values,
    await pageStatus(event, options, found, draft.page.blockMeta, draft.page.blockMeta),
    await pageComments(options, page.nid),
  )
}

/**
 * The page's conversations, or `undefined` when they were not asked for or
 * this server has no identity to ask Drupal with.
 *
 * A live session is the answer when one holds them: it carries what has been
 * said in it and not yet checkpointed, exactly as it carries the body. With no
 * session open, Drupal's copy is the whole of it (ADR 0006) — read as the
 * collab server, the way the session seeds itself (server/plugins/hocuspocus.ts),
 * because `use inline comments api` is a permission the caller's own carrier
 * need not hold and an agent token's scopes never name. A failed read is
 * raised: silence here is indistinguishable from "nobody has said anything".
 */
async function pageComments(
  options: KbPageOptions,
  nid: number,
): Promise<CommentThread[] | undefined> {
  if (!options.withComments) return undefined
  const live = await liveThreads(nid)
  if (live) return live
  if (!collabIdentityConfigured()) return undefined
  const stored = await asCollabServer(auth => fetchInlineComments(auth, 'node', nid))
  return threadsOfRecords(stored.messages ?? [])
}

/**
 * The page's editorial standing, or `undefined` when it was not asked for
 * or cannot be answered.
 *
 * The one source is `GET /openkb/node/<nid>/moderation` — the read the editor
 * chrome and the publish path already run, under the caller's own carrier, so
 * `can_publish` is this account's answer. That route is gated on `node.update`,
 * which is exactly what `canEdit` reports, so a reader who may not edit is
 * never sent into a 403.
 *
 * `blocks_pending` comes off the sidecar of the revision being projected,
 * filtered by the space's enforced steps.
 *
 * `can_publish` is the strict question: publishing now puts the page live.
 * The editor's toolbar asks a looser one — where a sign-off is what publishes,
 * pressing Publish records the ask instead of being refused — so this adds the
 * blockers to {@link canPublishNow}. They are counted on the **working copy**
 * whichever revision this read projects, because that is the revision a
 * publish transitions: a published read reporting the live page's zero
 * blockers would answer "go" on a write that only waits.
 *
 * A status that cannot be established leaves the field off rather than failing
 * the page: the content is what was asked for, the standing is the extra.
 */
async function pageStatus(
  event: H3Event,
  options: KbPageOptions,
  read: CePageRead,
  blockMeta: string,
  /** The working copy's sidecar, where the caller already read it. */
  workingCopyBlockMeta?: string,
): Promise<PageStatus | undefined> {
  const nid = read.page.nid
  if (!options.withStatus || !read.canEdit) return undefined

  const auth = forwardedAuthHeaders(event)
  let moderation: ModerationStatus
  let workingCopy = workingCopyBlockMeta ?? blockMeta
  try {
    moderation = await fetchModerationStatus(auth, nid)
    // Without a forward draft the working copy IS the revision just read.
    if (workingCopyBlockMeta === undefined && moderation.hasUnpublishedChanges) {
      workingCopy = (await fetchCeWorkingCopy(auth, nid, read)).page.blockMeta
    }
  }
  catch {
    return undefined
  }

  const steps = enforcedSteps(moderation)
  const owed = (meta: string): number => Object.keys(blockers(parseBlockMeta(meta), steps)).length

  return {
    draft_exists: moderation.hasUnpublishedChanges,
    blocks_pending: owed(blockMeta),
    can_publish: canPublishNow(moderation) && owed(workingCopy) === 0,
  }
}

/**
 * A body in the two forms a read needs: `body`, the stored bytes, and
 * `canonical`, the same content spelled as a commit would write it.
 *
 * Handed on as its own bytes — a legacy spelling must not be canonicalized
 * behind the reader's back — while versions are hashed off the canonical form,
 * so two spellings of one content version hash alike. Markdown that does not
 * round-trip is both served and hashed as stored.
 *
 * The title heading is already off (server/utils/title-heading.ts), so what a
 * read serves and what a write would hold are the same blocks: an agent's
 * `expect` version names a block the document has.
 *
 * Block versions hash the `canonical` half rather than parsing again
 * (server/utils/block-versions.ts).
 */
export function bodyForms(body: string): { body: string, canonical: string } {
  if (body.trim() === '') return { body, canonical: body }
  try {
    const json = parseMarkdownToDoc(body).toJSON() as ProseMirrorJSON
    return { body, canonical: serializeCommitJSON(json) }
  }
  catch {
    return { body, canonical: body }
  }
}

/** Projects one revision into a {@link KbPage}. */
function project(
  specs: FieldSpec[],
  path: string,
  title: string,
  storedBody: string,
  values: FieldValues,
  status?: PageStatus,
  comments?: CommentThread[],
): KbPage {
  const { body, canonical } = bodyForms(storedBody)
  return {
    path,
    title,
    frontmatter: projectFields(specs, values),
    // Whoever reads here reads source — a model over MCP, a person on the
    // `.md` address — so the body carries characters, not the serializer's
    // entities (ADR 0014). Frontmatter values never met the serializer.
    markdown: projectMarkdown(specs, values, decodePageEntities(body)),
    versions: blockVersions(canonical),
    ...(status ? { status } : {}),
    ...(comments ? { comments } : {}),
  }
}
