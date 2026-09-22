import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { H3Event } from 'h3'
import type { CommitResult } from './commit'
import { checkpointLiveDocument, moderationWriteError } from './moderation-session'

/**
 * Pins the one property the publish / revert paths share and cannot be seen to
 * have from their own code: they checkpoint through the SAME entry point every
 * other trigger does.
 *
 * A checkpoint is not just a PATCH. It closes the attribution ledger and
 * credits the burst to the peers who typed it, in the write that carries their
 * text. Assembling `commitDocument` here instead would still save the text and
 * silently skip all of that: the peer who saved checkpoints everybody's
 * typing under their own credential, so Drupal credits them for the lot and
 * the co-authors stay uncredited. An uncredited contributor is an eligible
 * approver of their own writing.
 *
 * So the test is about the call, not the outcome mapping below it: the day
 * somebody "simplifies" this back to a local commit, this is what says no.
 */

const checkpoint = vi.fn<() => Promise<CommitResult>>()
const commitDocument = vi.fn()
vi.mock('./hocuspocus', () => ({ useCheckpoint: () => checkpoint }))
// A cookie carrier names its account and carries nothing: the collaboration
// server carries the checkpoint and states whoever saved.
vi.mock('./actor', () => ({
  resolveActor: async () => ({ type: 'human', uid: 7, name: 'reviewer', via: null }),
}))
vi.mock('./commit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./commit')>()
  return { ...actual, commitDocument }
})

function event(headers: Record<string, string> = {}): H3Event {
  return { node: { req: { headers } } } as unknown as H3Event
}

const hp = (live: boolean) => ({ documents: new Map(live ? [['node:1', {}]] : []) })

describe('checkpointLiveDocument', () => {
  beforeEach(() => {
    checkpoint.mockReset()
    commitDocument.mockReset()
    checkpoint.mockResolvedValue({ outcome: 'committed', committed: true })
  })

  it('checkpoints through the one entry point, as the caller', async () => {
    await checkpointLiveDocument(hp(true), 'node:1', event({ cookie: 'SESS=reviewer' }))

    expect(checkpoint).toHaveBeenCalledWith('node:1', 'manual', { uid: 7, user: 'reviewer' })
    // Not a commit of its own — that is the whole point.
    expect(commitDocument).not.toHaveBeenCalled()
  })

  it('forwards an agent\'s bearer token as the carrier instead of a cookie', async () => {
    await checkpointLiveDocument(hp(true), 'node:1', event({ authorization: 'Bearer tok-123', cookie: 'SESS=x' }))

    expect(checkpoint).toHaveBeenCalledWith('node:1', 'manual', { token: 'tok-123' })
  })

  it('does not checkpoint a page nobody is editing', async () => {
    // No live document means nothing is pending: Drupal's working copy is
    // already the whole truth, and there is no ledger to settle.
    expect(await checkpointLiveDocument(hp(false), 'node:1', event({ cookie: 'SESS=x' })))
      .toEqual({ blocked: false })
    expect(checkpoint).not.toHaveBeenCalled()
  })

  it('blocks the moderation action on edits it could not write', async () => {
    checkpoint.mockResolvedValue({ outcome: 'conflict', committed: false, expected: 1, changed: 2 })

    expect(await checkpointLiveDocument(hp(true), 'node:1', event({ cookie: 'SESS=x' })))
      .toMatchObject({ blocked: true, statusCode: 409 })
  })

  it('lets a clean checkpoint through — nothing pending is not a failure', async () => {
    checkpoint.mockResolvedValue({ outcome: 'clean', committed: false })

    expect(await checkpointLiveDocument(hp(true), 'node:1', event({ cookie: 'SESS=x' })))
      .toEqual({ blocked: false })
  })

  it('lets an empty mid-flight document through — it holds nothing to lose', async () => {
    // A doc lingering in the map while its unload drains (or cleared for a
    // reseed) serializes empty against a non-empty page. No client edit
    // lives in it, so blocking would refuse to publish a working copy Drupal
    // already holds in full.
    checkpoint.mockResolvedValue({ outcome: 'empty-body', committed: false })

    expect(await checkpointLiveDocument(hp(true), 'node:1', event({ cookie: 'SESS=x' })))
      .toEqual({ blocked: false })
  })
})

describe('moderationWriteError', () => {
  it('forwards a stale revert as the conflict it is, not as a failure', async () => {
    // A revert is a read-modify-write and carries the revision it read
    // (OKB-167). Drupal refusing it 409 must reach the editor as the reload
    // banner every stale save gets — a 502 would read as "try again", and the
    // retry would overwrite the write that refused it.
    const err = moderationWriteError(
      { statusCode: 409, data: { drupalStatus: 409, conflict: { expected: 100, actual: 200 } } },
      'Revert failed',
    )
    expect(err).toMatchObject({ statusCode: 409, data: { expected: 100, actual: 200 } })
  })

  it('still tells a pending review apart from a refused person', () => {
    expect(moderationWriteError(
      { statusCode: 422, data: { drupalStatus: 422, violations: [{ meta: { blockId: 'b-1' } }] } },
      'Publish failed',
    )).toMatchObject({ statusCode: 422 })
    expect(moderationWriteError({ statusCode: 403, data: { drupalStatus: 403 } }, 'Publish failed'))
      .toMatchObject({ statusCode: 403 })
  })

  it('keeps a structural refusal a 422, carrying Drupal\'s own sentence', () => {
    // Text outside identified blocks names no block — there is no review lane
    // to clear. Collapsing it into 403 would tell an editor they lack a
    // permission for something one keystroke fixes.
    const detail = 'Publishing is blocked: the body must consist of identified blocks.'
    expect(moderationWriteError(
      { statusCode: 422, data: { drupalStatus: 422, violations: [{ detail }] } },
      'Publish failed',
    )).toMatchObject({ statusCode: 422, statusMessage: detail, data: { violations: [{ detail }] } })
  })

  it('drops core\'s JSON:API envelope from the sentence the editor reads', () => {
    // An entity-level violation leaves JSON:API as "Entity is not valid: …".
    // That prefix is core talking about a payload, not the product telling an
    // editor what to do next.
    const detail = 'Publishing is blocked: the body must consist of identified blocks.'
    expect(moderationWriteError(
      { statusCode: 422, data: { drupalStatus: 422, violations: [{ detail: `Entity is not valid: ${detail}` }] } },
      'Publish failed',
    )).toMatchObject({ statusCode: 422, statusMessage: detail })
  })
})
