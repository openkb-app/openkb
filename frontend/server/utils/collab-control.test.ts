import { describe, it, expect, vi } from 'vitest'
import { inspectDocument, settleDocument, unloadMayRelease, type CollabControlDeps, type SettleableDocument } from './collab-control'
import { META_DELETED_AT } from '#shared/utils/collab-meta'
import { CheckpointScheduler } from './commit-scheduler'
import type { CommitResult } from './commit'

interface Harness {
  deps: CollabControlDeps
  calls: string[]
  meta: Map<string, unknown>
}

function harness(options: { connections?: number, live?: boolean } = {}): Harness {
  const calls: string[] = []
  const meta = new Map<string, unknown>()
  const document: SettleableDocument = {
    getConnectionsCount: () => options.connections ?? 0,
    getMap: () => ({
      set: (key, value) => {
        calls.push(`meta:${key}`)
        meta.set(key, value)
      },
    }),
  }
  const documents = new Map<string, SettleableDocument>()
  if (options.live !== false) documents.set('node:7', document)

  return {
    calls,
    meta,
    deps: {
      documents,
      retire: (_docName: string) => calls.push('retire'),
      disarm: () => calls.push('disarm'),
      waitIdle: async () => { calls.push('waitIdle') },
      closeConnections: () => calls.push('closeConnections'),
      unload: async () => { calls.push('unload') },
      sleep: async () => { calls.push('sleep') },
    },
  }
}

describe('settleDocument', () => {
  it('retires before draining, and closes connections only after the notice', async () => {
    const h = harness({ connections: 2 })
    const report = await settleDocument(h.deps, 'node:7')

    expect(h.calls).toEqual([
      'retire',
      'disarm',
      'waitIdle',
      `meta:${META_DELETED_AT}`,
      'sleep',
      'closeConnections',
      'unload',
    ])
    expect(report).toEqual({ live: true, connections: 2 })
    expect(Number(h.meta.get(META_DELETED_AT))).toBeGreaterThan(0)
  })

  it('skips the deletion notice when nobody is connected', async () => {
    const h = harness({ connections: 0 })
    await settleDocument(h.deps, 'node:7')

    expect(h.calls).not.toContain(`meta:${META_DELETED_AT}`)
    expect(h.calls).not.toContain('sleep')
    expect(h.calls).toContain('closeConnections')
  })

  it('still retires and drains a document nobody has open', async () => {
    const h = harness({ live: false })
    const report = await settleDocument(h.deps, 'node:7')

    expect(h.calls).toEqual(['retire', 'disarm', 'waitIdle'])
    expect(report).toEqual({ live: false, connections: 0 })
  })

  it('retires the document before anything else', async () => {
    // Retire first: step 4 disconnects peers, and a last-peer-disconnect
    // would otherwise fire a checkpoint straight into the delete.
    const h = harness({ live: false })
    await settleDocument(h.deps, 'node:7')

    expect(h.calls[0]).toBe('retire')
  })

  it('an unload failure does not fail the settle', async () => {
    const h = harness({ connections: 1 })
    h.deps.unload = () => Promise.reject(new Error('already unloading'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(settleDocument(h.deps, 'node:7')).resolves.toEqual({ live: true, connections: 1 })
  })

  it('drains the scheduler: waitIdle resolves only after the in-flight commit', async () => {
    // The whole point of the ordering — the delete must not overlap a
    // checkpoint PATCH. Wired to a real scheduler, not a stub, because the
    // guarantee depends on disarm() keeping the state waitIdle reads.
    let release: (r: CommitResult) => void = () => {}
    const commit = vi.fn(() => new Promise<CommitResult>((resolve) => { release = resolve }))
    const scheduler = new CheckpointScheduler({ quietMs: 5, maxDirtyMs: 50, commit })

    scheduler.onActivity('node:7')
    await new Promise(r => setTimeout(r, 20))
    expect(commit).toHaveBeenCalledOnce()

    const h = harness({ connections: 1 })
    h.deps.disarm = docName => scheduler.disarm(docName)
    h.deps.waitIdle = docName => scheduler.waitIdle(docName)

    let settled = false
    const settling = settleDocument(h.deps, 'node:7').then(() => { settled = true })
    await new Promise(r => setTimeout(r, 20))
    expect(settled).toBe(false)
    expect(h.calls).not.toContain('closeConnections')

    release({ outcome: 'committed', committed: true })
    await settling
    expect(settled).toBe(true)
    expect(h.calls).toContain('closeConnections')
  })

  it('drops a disconnect queued behind the in-flight commit', async () => {
    // A disconnect that collides with a running commit runs after it — except
    // when the document is being deleted. The drain would otherwise resolve
    // onto a PATCH that is about to start, which is the 500 this ordering
    // exists to prevent.
    let release: (r: CommitResult) => void = () => {}
    const commit = vi.fn(() => new Promise<CommitResult>((resolve) => { release = resolve }))
    const scheduler = new CheckpointScheduler({ quietMs: 5, maxDirtyMs: 50, commit })

    scheduler.onActivity('node:7')
    await new Promise(r => setTimeout(r, 20))
    scheduler.onDisconnect('node:7', 0) // queued: a commit is running
    expect(commit).toHaveBeenCalledOnce()

    const h = harness({ connections: 1 })
    h.deps.disarm = docName => scheduler.disarm(docName)
    h.deps.waitIdle = docName => scheduler.waitIdle(docName)

    const settling = settleDocument(h.deps, 'node:7')
    release({ outcome: 'committed', committed: true })
    await settling

    await new Promise(r => setTimeout(r, 20))
    expect(commit).toHaveBeenCalledOnce()
  })
})

describe('inspectDocument', () => {
  it('reports a live document without standing any of it down', () => {
    const h = harness({ connections: 2 })

    expect(inspectDocument(h.deps.documents, 'node:7')).toEqual({ live: true, connections: 2 })
    expect(h.calls).toEqual([])
  })

  it('reports a document nobody has open as settled', () => {
    const h = harness({ live: false })

    expect(inspectDocument(h.deps.documents, 'node:7')).toEqual({ live: false, connections: 0 })
    expect(h.calls).toEqual([])
  })

  it('answers per document, not per server', () => {
    const h = harness({ connections: 4 })

    expect(inspectDocument(h.deps.documents, 'node:8')).toEqual({ live: false, connections: 0 })
  })
})

describe('unloadMayRelease', () => {
  it('releases what no other session has claimed', () => {
    expect(unloadMayRelease(3, 3)).toBe(true)
  })

  it('keeps state a session claimed while the unload was still running', () => {
    // The whole point. Unload waits for the departing session's checkpoint,
    // and the arriving session authenticates inside that wait — so the carrier
    // this would delete is the new session's, not the old one's. Without it
    // that session reads Drupal under no credential, which every lane answers
    // null to: it keeps the previous page's conversations under a reissued
    // node id and has nothing to checkpoint with.
    expect(unloadMayRelease(3, 4)).toBe(false)
  })

  it('releases when the unload was never seen beginning', () => {
    // Nothing was captured, so nothing can be compared, and holding every
    // document's state forever on that basis is the worse answer.
    expect(unloadMayRelease(undefined, 0)).toBe(true)
    expect(unloadMayRelease(undefined, 7)).toBe(true)
  })

  it('counts a claim taken on a document that had none', () => {
    expect(unloadMayRelease(0, 1)).toBe(false)
  })
})
