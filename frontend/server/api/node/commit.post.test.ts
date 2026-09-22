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
// The handler reads nothing from Drupal of its own; this catches it starting
// to.
const drupalRead = vi.fn<() => Promise<unknown>>()
vi.mock('../../utils/drupal', () => ({
  drupalFetchWithCookie: (...args: unknown[]) => drupalRead(...args as []),
}))
// The cookie names the caller; the checkpoint that follows states them and is
// performed as them, so the handler resolves the account before it commits.
const actor = vi.fn(async () => ({ type: 'human', uid: 7, name: 'ada', via: null }))
vi.mock('../../utils/actor', () => ({ resolveActor: () => actor() }))

function event(id: string, cookie?: string): H3Event {
  return {
    context: { params: { id } },
    node: { req: { headers: cookie ? { cookie } : {} } },
  } as unknown as H3Event
}

describe('POST /api/node/:id/commit', () => {
  beforeEach(() => {
    documents.clear()
    documents.set('node:1', {})
    openDirectConnection.mockReset()
    checkpoint.mockReset()
    drupalRead.mockReset()
  })

  it('committed → { ok, committed, changed, review }', async () => {
    checkpoint.mockResolvedValue({ outcome: 'committed', committed: true, changed: 200 })
    await expect(handler(event('1', 'SESS=x'))).resolves.toEqual({ nid: 1, ok: true, committed: true, changed: 200, review: null })
    expect(checkpoint).toHaveBeenCalledWith('node:1', 'manual', { uid: 7, user: 'ada' })
  })

  it('is one checkpoint and no read of its own', async () => {
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
