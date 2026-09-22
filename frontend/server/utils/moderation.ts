import {
  commitKbPageWithAuth,
  drupalFetchWithAuth,
  fetchCeNode,
  fetchCeWorkingCopy,
  type KbPagePatchExtra,
} from './drupal'
import { createRefTypeResolver, fieldsPatchPayload } from './commit-fields'
import { mapCeFieldValues, TITLE_KEY, type FieldSpec, type FieldValues } from './entity-fields'
import type { ModerationStatus } from '#shared/utils/moderation'

/**
 * The document-level moderation actions — the editor's Publish and Revert.
 *
 * Both are writes through the one commit route (`POST /openkb/node/<nid>/commit`,
 * openkb_collab_api's CommitResource), which already owns the two branches they
 * need — no transport of their own:
 *
 *   - **Publish** names `moderation_state` in the payload, which the route
 *     treats as "a deliberate editorial act … honoured as sent": the write
 *     answers to content_moderation's transition check, so an editor without
 *     the `publish` transition is refused by Drupal, not by this layer.
 *   - **Revert** names no state, so the route's content-write branch lands it
 *     as a *draft* — a new forward revision holding the published content.
 *     History is preserved: nothing is deleted, the discarded draft stays in
 *     the revision list, and the live published revision was never touched.
 *
 * Neither action decides permission. The chrome hides what
 * {@link fetchModerationStatus} says is unavailable; Drupal enforces it.
 *
 * The live collab document is the caller's business (server/api/node/…): a
 * write here is only half a revert, the other half is the session converging —
 * see resetDocumentToBody in ./doc-seed.
 */

/** The state a published page's working copy carries. */
export const PUBLISHED_STATE = 'published'

/**
 * Reads the page's moderation standing as the given carrier.
 *
 * Errors are the caller's to map: a 403 here is meaningful (no edit access),
 * so unlike the space-manage probe this one does not swallow failures into a
 * negative answer.
 */
export function fetchModerationStatus(
  auth: Record<string, string>,
  nid: number,
): Promise<ModerationStatus> {
  // The status endpoint speaks plain JSON, not JSON:API.
  return drupalFetchWithAuth<ModerationStatus>(auth, `/openkb/node/${nid}/moderation`, {
    headers: { Accept: 'application/json' },
  })
}

/**
 * Publishes the working copy — the transition, and nothing else.
 *
 * The payload names only the state, so the route applies it to the latest
 * revision as it stands: whatever the session last checkpointed is what goes
 * live. Sending a body alongside would publish the *sender's* idea of the
 * content, which is a different (and racier) operation than "publish what is
 * in the working copy".
 *
 * @returns Drupal's `changed` for the published revision.
 */
export function publishWorkingCopy(auth: Record<string, string>, nid: number): Promise<number> {
  return commitStateOnly(auth, nid, PUBLISHED_STATE)
}

/**
 * The published content of a page, as a commit payload.
 *
 * Read from the *default* revision — the one the public read page serves —
 * across the body and every field the frontmatter contract exposes. Reverting
 * the body alone would leave the reverted text under the draft's title and
 * metadata, which is not "back to published".
 */
export interface PublishedContent {
  body: string
  /** The published body's title heading, to write back with it — the title is
   *  a node field, not the document's (server/utils/title-heading.ts). */
  titleHeading: string
  /**
   * The published `field_block_meta` — the block-provenance sidecar.
   *
   * It travels with the body because it is keyed by *that body's* block ids: a
   * revert that restored the body alone would leave the draft's sidecar naming
   * blocks the page no longer has, which the next commit's coherence sweep
   * then drops — making an untouched document look dirty forever.
   */
  blockMeta: string
  values: FieldValues
  payload: KbPagePatchExtra
  /**
   * The working copy's `changed` this revert was assembled against.
   *
   * A revert is a read-modify-write like any other: it reads the published
   * revision, then writes it over whatever the working copy is. Between the
   * two somebody can land a revision, and without a token the revert would
   * discard it silently. Sent as `based_on_changed`; Drupal refuses a stale
   * one with 409 (OKB-167).
   */
  basedOnChanged: number
}

export interface PublishedContentDeps {
  /** The exposed-field contract, or null when the schema is unreachable. */
  fetchSpecs: () => Promise<FieldSpec[] | null>
}

/**
 * Assembles what a revert has to write: the published body plus the published
 * value of every exposed field. Both come off the one live ce-api read.
 *
 * A schema read that fails degrades to a body-only revert rather than blocking
 * one: the body is the content the user is looking at when they press the
 * button, and a revert that refuses because a reference label could not be
 * resolved is worse than a revert that leaves the frontmatter alone. The
 * caller reports which of the two happened.
 */
export async function publishedContent(
  auth: Record<string, string>,
  nid: number,
  deps: PublishedContentDeps,
): Promise<PublishedContent> {
  const published = await fetchCeNode(auth, nid)
  // The revision the revert overwrites. Taken after the session was
  // checkpointed, so the token names what the write will actually land on.
  const workingCopy = await fetchCeWorkingCopy(auth, nid, published)
  const basedOnChanged = workingCopy.page.changed

  const specs = await deps.fetchSpecs()
  if (!specs) {
    console.error(`[moderation] node ${nid}: published field values unavailable — reverting the body only`)
    return {
      body: published.page.body,
      titleHeading: published.page.titleHeading,
      blockMeta: published.page.blockMeta,
      values: {},
      payload: {},
      basedOnChanged,
    }
  }
  // Keys come from the `frontmatter` form display, values from the `full` CE
  // display: a field exposed on the form display alone would revert to empty,
  // so the two displays carry the same field set.
  const values = mapCeFieldValues(specs, published.props)

  // Every exposed key, not a diff: the point of a revert is that the working
  // copy *equals* the published revision afterwards, and a field the draft
  // changed is exactly the one a diff computed from the draft would miss.
  const keys = [TITLE_KEY, ...specs.map(spec => spec.key)].filter(key => key in values)
  const payload = await fieldsPatchPayload(specs, values, keys, createRefTypeResolver(auth))
  return {
    body: published.page.body,
    titleHeading: published.page.titleHeading,
    blockMeta: published.page.blockMeta,
    values,
    payload,
    basedOnChanged,
  }
}

/**
 * Writes the published content back as a new draft revision.
 *
 * Conditional on the revision it was assembled against: an external write
 * landing in between is refused 409 rather than discarded.
 *
 * @returns Drupal's `changed` for the written revision.
 */
export async function commitPublishedContent(
  auth: Record<string, string>,
  nid: number,
  content: PublishedContent,
): Promise<number> {
  // Joined by hand rather than through `storedBody()`: a revert restores the
  // published bytes as they stand — no respelling, no newline normalisation.
  const { changed } = await commitKbPageWithAuth(auth, nid, content.titleHeading + content.body, {
    ...content.payload,
    basedOnChanged: content.basedOnChanged,
    attributes: {
      // Named rather than left to the route: a revert discards the draft, so
      // it says which state it lands in rather than letting the commit decide.
      moderation_state: 'draft',
      revision_log: 'OpenKB revert to published',
      // Written unconditionally, empty string included: the draft's sidecar
      // has to go even when the published revision carries none.
      field_block_meta: content.blockMeta,
      ...(content.payload.attributes ?? {}),
    },
  })
  return changed
}

/**
 * A commit carrying a moderation state and no content.
 *
 * The route applies the payload to the latest revision, so an attributes-only
 * payload changes exactly the state — the body and fields of the working copy
 * ride along untouched into the new revision.
 */
function commitStateOnly(
  auth: Record<string, string>,
  nid: number,
  state: string,
): Promise<number> {
  return drupalFetchWithAuth<{ data?: { attributes?: { changed: string } } }>(
    auth,
    `/openkb/node/${nid}/commit`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attributes: {
          moderation_state: state,
          revision_log: `OpenKB moderation transition (${state})`,
        },
      }),
    },
  ).then((result) => {
    const iso = result?.data?.attributes?.changed
    return iso ? Math.floor(new Date(iso).getTime() / 1000) : Math.floor(Date.now() / 1000)
  })
}
