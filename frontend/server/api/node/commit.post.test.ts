import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { H3Event } from 'h3'
import type { CommitResult } from '../../utils/commit'
import handler from './[id]/commit.post'

const documents = new Map<string, unknown>()
const openDirectConnection = vi.fn()
// The handler runs the one checkpoint path, not a commit of its own — that is
// what puts the attribution settle on the manual Save as well.
const checkpoint = vi.fn<() => Promise<CommitResult>>()
vi.mock('../../utils/hocuspocus', () => ({
  useHocuspocus: () => ({ documents, openDirectConnection }),
  useCheckpoint: () => checkpoint,
}))
// Besides the join gate, the handler reads nothing from Drupal; this catches it
// starting to.
const drupalRead = vi.fn<() => Promise<unknown>>()
vi.mock('../../utils/drupal', () => ({
  drupalBaseUrl: () => 'http://drupal',
  drupalFetchWithAuth: (...args: unknown[]) => drupalRead(...args as []),
}))
// Drupal's join gate under the caller's carrier: it admits the caller and names
// the account the checkpoint states.
const fetchUpstream = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
vi.mock('../../utils/upstream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/upstream')>()
  return { ...actual, fetchUpstream: (url: string, init?: RequestInit) => fetchUpstream(url, init) }
})

/** A join-access answer for account `uid`. */
function joinAnswer(update: boolean, uid = 7): Response {
  return Response.json({ account: { uid, name: 'ada' }, update, denied_fields: [] })
}

function event(id: string, cookie?: string, authorization?: string): H3Event {
  const headers: Record<string, string> = {}
  if (cookie) headers.cookie = cookie
  if (authorization) headers.authorization = authorization
  return {
    context: { params: { id } },
    node: { req: { headers } },
  } as unknown as H3Event
}

describe('POST /api/node/:id/commit', () => {
  beforeEach(() => {
    documents.clear()
    documents.set('node:1', {})
    openDirectConnection.mockReset()
    checkpoint.mockReset()
    drupalRead.mockReset()
    fetchUpstream.mockReset()
    fetchUpstream.mockResolvedValue(joinAnswer(true))
  })

  it('committed → { ok, committed, changed, review }', async () => {
    checkpoint.mockResolvedValue({ outcome: 'committed', committed: true, changed: 200 })
    await expect(handler(event('1', 'SESS=x'))).resolves.toEqual({ nid: 1, ok: true, committed: true, changed: 200, review: null })
    expect(checkpoint).toHaveBeenCalledWith('node:1', 'manual', { uid: 7 })
  })

  it('is one checkpoint and no content read', async () => {
    checkpoint.mockResolvedValue({ outcome: 'committed', committed: true, changed: 200 })
    await handler(event('1', 'SESS=x'))

    // A Save is content and lands as a draft revision like any checkpoint —
    // there is no state for this route to ask about. Asserted as counts so
    // neither a second write nor a pre-read can come back unnoticed.
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(drupalRead).not.toHaveBeenCalled()
  })

  it('clean → committed:false', async () => {
    checkpoint.mockResolvedValue({ outcome: 'clean', committed: false })
    await expect(handler(event('1', 'SESS=x'))).resolves.toEqual({ nid: 1, ok: true, committed: false })
  })

  it('conflict → 409 with { expected, actual }', async () => {
    checkpoint.mockResolvedValue({ outcome: 'conflict', committed: false, expected: 100, changed: 200 })
    await expect(handler(event('1', 'SESS=x'))).rejects.toMatchObject({
      statusCode: 409,
      data: { expected: 100, actual: 200 },
    })
  })

  it('invalid → 422', async () => {
    checkpoint.mockResolvedValue({ outcome: 'invalid', committed: false, message: 'bad body' })
    await expect(handler(event('1', 'SESS=x'))).rejects.toMatchObject({ statusCode: 422 })
  })

  it('invalid with per-field messages → 422 carrying data.fields', async () => {
    checkpoint.mockResolvedValue({
      outcome: 'invalid',
      committed: false,
      message: 'Validation failed',
      fields: { field_owner: ['Referenced user "Ghost" does not exist.'] },
    })
    await expect(handler(event('1', 'SESS=x'))).rejects.toMatchObject({
      statusCode: 422,
      data: { fields: { field_owner: ['Referenced user "Ghost" does not exist.'] } },
    })
  })

  it('missing cookie → 401, no commit attempted', async () => {
    await expect(handler(event('1'))).rejects.toMatchObject({ statusCode: 401 })
    expect(checkpoint).not.toHaveBeenCalled()
  })

  it('read-only Bearer with a junk cookie → 403, no checkpoint', async () => {
    fetchUpstream.mockResolvedValue(joinAnswer(false))

    await expect(handler(event('1', 'junk=1', 'Bearer read-only'))).rejects.toMatchObject({ statusCode: 403 })
    expect(fetchUpstream.mock.calls[0]![1]!.headers).toEqual({ Accept: 'application/json', Authorization: 'Bearer read-only' })
    expect(checkpoint).not.toHaveBeenCalled()
  })

  it('a cookie Drupal reads as anonymous → 401, no checkpoint', async () => {
    fetchUpstream.mockResolvedValue(joinAnswer(false, 0))

    await expect(handler(event('1', 'SESS=stale'))).rejects.toMatchObject({ statusCode: 401 })
    expect(checkpoint).not.toHaveBeenCalled()
  })

  it('no live doc → opens a direct connection, commits, then disconnects', async () => {
    documents.clear()
    const disconnect = vi.fn().mockResolvedValue(undefined)
    openDirectConnection.mockResolvedValue({ disconnect })
    checkpoint.mockResolvedValue({ outcome: 'committed', committed: true, changed: 5 })
    await expect(handler(event('1', 'SESS=x'))).resolves.toMatchObject({ committed: true })
    expect(openDirectConnection).toHaveBeenCalledWith('node:1', { cookie: 'SESS=x' })
    expect(disconnect).toHaveBeenCalledOnce()
  })
})
