import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'
import type { CommitResult } from './commit'
import { checkpointLiveDocument, moderationWriteError } from './moderation-session'
import { makeEvent } from '../test-support/h3'

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
vi.mock('./drupal', () => ({ drupalBaseUrl: () => 'http://drupal' }))
// Drupal's join gate under the caller's carrier: the carrier names the account
// and carries nothing; the collaboration server carries the checkpoint.
const fetchUpstream = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
vi.mock('./upstream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./upstream')>()
  return { ...actual, fetchUpstream: (url: string, init?: RequestInit) => fetchUpstream(url, init) }
})
vi.mock('./commit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./commit')>()
  return { ...actual, commitDocument }
})

/** A join-access answer: node update for account `uid`, and the fields out of reach. */
function joinAnswer(update: boolean, uid = 7, deniedFields: string[] = []): Response {
  return Response.json({ account: { uid, name: 'reviewer' }, update, denied_fields: deniedFields })
}

const hp = (live: boolean, doc = new Y.Doc()) => ({ documents: new Map(live ? [['node:1', doc]] : []) })

describe('checkpointLiveDocument', () => {
  beforeEach(() => {
    checkpoint.mockReset()
    commitDocument.mockReset()
    fetchUpstream.mockReset()
    checkpoint.mockResolvedValue({ outcome: 'committed', committed: true })
    fetchUpstream.mockResolvedValue(joinAnswer(true))
  })

  describe.each([true, false])('live session: %s', (live) => {
    // Both paths answer the same, so a caller learns nothing about who is
    // editing.
    it('refuses a made-up token', async () => {
      fetchUpstream.mockResolvedValue(new Response('', { status: 401 }))

      await expect(checkpointLiveDocument(hp(live), 1, makeEvent({ authorization: 'Bearer made-up' })))
        .rejects.toMatchObject({ statusCode: 401 })
      expect(checkpoint).not.toHaveBeenCalled()
    })

    it('refuses a caller who may not view the page', async () => {
      fetchUpstream.mockResolvedValue(new Response('', { status: 403 }))

      await expect(checkpointLiveDocument(hp(live), 1, makeEvent({ cookie: 'SESS=x' })))
        .rejects.toMatchObject({ statusCode: 403, statusMessage: 'Request failed (403)' })
      expect(checkpoint).not.toHaveBeenCalled()
    })

    it('refuses a read-only token', async () => {
      fetchUpstream.mockResolvedValue(joinAnswer(false))

      expect(await checkpointLiveDocument(hp(live), 1, makeEvent({ authorization: 'Bearer read-only' })))
        .toEqual({ blocked: true, statusCode: 403, message: 'You do not have permission to make this change.' })
      expect(checkpoint).not.toHaveBeenCalled()
    })
  })

  it('refuses a caller without edit access to a session field', async () => {
    fetchUpstream.mockResolvedValue(joinAnswer(true, 7, ['field_owner']))

    expect(await checkpointLiveDocument(hp(true), 1, makeEvent({ cookie: 'SESS=x' })))
      .toMatchObject({ blocked: true, statusCode: 403 })
    expect(checkpoint).not.toHaveBeenCalled()
  })

  it.each([true, false])('refuses a cookie Drupal reads as anonymous (update: %s) with 401', async (update) => {
    fetchUpstream.mockResolvedValue(joinAnswer(update, 0))

    await expect(checkpointLiveDocument(hp(true), 1, makeEvent({ cookie: 'SESS=stale' })))
      .rejects.toMatchObject({ statusCode: 401 })
    expect(checkpoint).not.toHaveBeenCalled()
  })

  it('checkpoints nothing when the join gate is unavailable', async () => {
    fetchUpstream.mockResolvedValue(new Response('', { status: 503 }))

    await expect(checkpointLiveDocument(hp(true), 1, makeEvent({ cookie: 'SESS=x' })))
      .rejects.toMatchObject({ statusCode: 503 })
    expect(checkpoint).not.toHaveBeenCalled()
  })

  it('checkpoints through the one entry point, as the caller', async () => {
    await checkpointLiveDocument(hp(true), 1, makeEvent({ cookie: 'SESS=reviewer' }))

    expect(fetchUpstream).toHaveBeenCalledWith(
      'http://drupal/openkb/node/1/join-access',
      { headers: { Accept: 'application/json', Cookie: 'SESS=reviewer' }, signal: expect.any(AbortSignal) },
    )
    expect(checkpoint).toHaveBeenCalledWith('node:1', 'manual', { uid: 7 })
    // Not a commit of its own — that is the whole point.
    expect(commitDocument).not.toHaveBeenCalled()
  })

  it('asks under the token alone and checkpoints as its owner', async () => {
    await checkpointLiveDocument(hp(true), 1, makeEvent({ authorization: 'Bearer tok-123', cookie: 'SESS=x' }))

    expect(fetchUpstream).toHaveBeenCalledWith(
      'http://drupal/openkb/node/1/join-access',
      { headers: { Accept: 'application/json', Authorization: 'Bearer tok-123' }, signal: expect.any(AbortSignal) },
    )
    expect(checkpoint).toHaveBeenCalledWith('node:1', 'manual', { uid: 7 })
  })

  it('does not checkpoint a page nobody is editing', async () => {
    // No live document means nothing is pending: Drupal's working copy is
    // already the whole truth, and there is no ledger to settle.
    expect(await checkpointLiveDocument(hp(false), 1, makeEvent({ cookie: 'SESS=x' })))
      .toEqual({ blocked: false })
    expect(checkpoint).not.toHaveBeenCalled()
  })

  it('blocks the moderation action on edits it could not write', async () => {
    checkpoint.mockResolvedValue({ outcome: 'conflict', committed: false, expected: 1, changed: 2 })

    expect(await checkpointLiveDocument(hp(true), 1, makeEvent({ cookie: 'SESS=x' })))
      .toMatchObject({ blocked: true, statusCode: 409 })
  })

  it('reports the refusal of a checkpoint Drupal found invalid', async () => {
    checkpoint.mockResolvedValue({ outcome: 'invalid', committed: false, message: 'Title is required.' })

    expect(await checkpointLiveDocument(hp(true), 1, makeEvent({ cookie: 'SESS=x' })))
      .toMatchObject({ blocked: true, statusCode: 422, message: 'Title is required.' })
  })

  it('reports a server without its Drupal credential', async () => {
    checkpoint.mockResolvedValue({ outcome: 'no-credentials', committed: false })

    expect(await checkpointLiveDocument(hp(true), 1, makeEvent({ cookie: 'SESS=x' })))
      .toMatchObject({ blocked: true, statusCode: 503 })
  })

  it('lets a clean checkpoint through — nothing pending is not a failure', async () => {
    checkpoint.mockResolvedValue({ outcome: 'clean', committed: false })

    expect(await checkpointLiveDocument(hp(true), 1, makeEvent({ cookie: 'SESS=x' })))
      .toEqual({ blocked: false })
  })

  it('lets an empty mid-flight document through — it holds nothing to lose', async () => {
    // A doc lingering in the map while its unload drains (or cleared for a
    // reseed) serializes empty against a non-empty page. No client edit
    // lives in it, so blocking would refuse to publish a working copy Drupal
    // already holds in full.
    checkpoint.mockResolvedValue({ outcome: 'empty-body', committed: false })

    expect(await checkpointLiveDocument(hp(true), 1, makeEvent({ cookie: 'SESS=x' })))
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
