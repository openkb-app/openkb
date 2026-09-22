import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CheckpointScheduler } from './commit-scheduler'
import type { CommitResult } from './commit'

const ok: CommitResult = { outcome: 'committed', committed: true }

function make(commit: (doc: string, trigger: string) => Promise<CommitResult>, quietMs = 1000, maxDirtyMs = 10_000) {
  return new CheckpointScheduler({ quietMs, maxDirtyMs, commit: commit as never })
}

describe('CheckpointScheduler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('quiet: fires once after inactivity, then not again', async () => {
    const commit = vi.fn().mockResolvedValue(ok)
    const s = make(commit)
    s.onActivity('node:1')

    await vi.advanceTimersByTimeAsync(999)
    expect(commit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(commit).toHaveBeenCalledExactlyOnceWith('node:1', 'quiet', undefined)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('quiet timer resets on each edit', async () => {
    const commit = vi.fn().mockResolvedValue(ok)
    const s = make(commit)
    s.onActivity('node:1')
    await vi.advanceTimersByTimeAsync(500)
    s.onActivity('node:1')
    await vi.advanceTimersByTimeAsync(500)
    expect(commit).not.toHaveBeenCalled() // reset pushed it out
    await vi.advanceTimersByTimeAsync(500)
    expect(commit).toHaveBeenCalledExactlyOnceWith('node:1', 'quiet', undefined)
  })

  it('max-dirty backstop fires under continuous editing (quiet never elapses)', async () => {
    const commit = vi.fn().mockResolvedValue(ok)
    const s = make(commit, 1000, 3000)
    s.onActivity('node:1')
    // Edit every 500ms so the quiet timer never reaches 1000ms.
    for (let t = 500; t < 3000; t += 500) {
      await vi.advanceTimersByTimeAsync(500)
      s.onActivity('node:1')
    }
    await vi.advanceTimersByTimeAsync(500)
    expect(commit).toHaveBeenCalledExactlyOnceWith('node:1', 'max-dirty', undefined)
  })

  it('disconnect: fires immediately and cancels the pending quiet timer', async () => {
    const commit = vi.fn().mockResolvedValue(ok)
    const s = make(commit)
    s.onActivity('node:1')
    s.onDisconnect('node:1', 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(commit).toHaveBeenCalledExactlyOnceWith('node:1', 'disconnect', undefined)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('disconnect with remaining peers does nothing', async () => {
    const commit = vi.fn().mockResolvedValue(ok)
    const s = make(commit)
    s.onActivity('node:1')
    s.onDisconnect('node:1', 2)
    await vi.advanceTimersByTimeAsync(0)
    expect(commit).not.toHaveBeenCalled()
  })

  it('a disconnect colliding with a running commit waits for it, then still runs', async () => {
    // The last peer leaving is the document's final checkpoint — the unload
    // follows it, so a trigger deferred to a timer here is a trigger dropped.
    const releases: Array<() => void> = []
    const commit = vi.fn().mockImplementation(
      () => new Promise<CommitResult>((r) => { releases.push(() => r(ok)) }),
    )
    const s = make(commit)

    s.onActivity('node:1')
    await vi.advanceTimersByTimeAsync(1000) // quiet fires → commit in flight
    expect(commit).toHaveBeenCalledTimes(1)

    s.onDisconnect('node:1', 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(commit).toHaveBeenCalledTimes(1) // never two at once

    releases[0]!()
    await vi.advanceTimersByTimeAsync(0)
    expect(commit).toHaveBeenCalledTimes(2)
    expect(commit).toHaveBeenLastCalledWith('node:1', 'disconnect', undefined)

    releases[1]!()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(commit).toHaveBeenCalledTimes(2)
  })

  it('a quiet trigger colliding with a running commit re-arms the quiet timer', async () => {
    let release!: () => void
    const commit = vi.fn().mockImplementation(() => new Promise<CommitResult>((r) => { release = () => r(ok) }))
    const s = make(commit)

    const manual = s.checkpoint('node:1', 'manual', { cookie: 'SESS-ada' })
    await vi.advanceTimersByTimeAsync(0)
    s.onActivity('node:1')
    await vi.advanceTimersByTimeAsync(1000) // quiet fires into the running commit
    expect(commit).toHaveBeenCalledTimes(1)

    release()
    await manual
    await vi.advanceTimersByTimeAsync(0)
    expect(commit).toHaveBeenCalledTimes(1) // deferred, not run
    await vi.advanceTimersByTimeAsync(1000)
    expect(commit).toHaveBeenLastCalledWith('node:1', 'quiet', undefined)
  })

  it('a max-dirty trigger colliding with a running commit re-arms the quiet timer', async () => {
    let release!: () => void
    const commit = vi.fn().mockImplementation(() => new Promise<CommitResult>((r) => { release = () => r(ok) }))
    const s = make(commit, 1000, 3000)

    const manual = s.checkpoint('node:1', 'manual', { cookie: 'SESS-ada' })
    await vi.advanceTimersByTimeAsync(0)
    s.onActivity('node:1')
    for (let t = 0; t < 3000; t += 500) {
      await vi.advanceTimersByTimeAsync(500)
      s.onActivity('node:1')
    }
    expect(commit).toHaveBeenCalledTimes(1)

    release()
    await manual
    await vi.advanceTimersByTimeAsync(0)
    expect(commit).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(commit).toHaveBeenLastCalledWith('node:1', 'quiet', undefined)
  })

  it('disarm drops a disconnect queued behind a running commit', async () => {
    // The settle path stands a document down for a delete: no PATCH may follow.
    let release!: () => void
    const commit = vi.fn().mockImplementation(() => new Promise<CommitResult>((r) => { release = () => r(ok) }))
    const s = make(commit)

    const manual = s.checkpoint('node:1', 'manual', { cookie: 'SESS-ada' })
    await vi.advanceTimersByTimeAsync(0)
    s.onDisconnect('node:1', 0)
    s.disarm('node:1')

    release()
    await manual
    await vi.advanceTimersByTimeAsync(60_000)
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('says so loudly when the final checkpoint wrote nothing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const commit = vi.fn().mockResolvedValue({ outcome: 'error', committed: false, message: 'drupal down' })
    const s = make(commit)

    s.onDisconnect('node:1', 0)
    await vi.advanceTimersByTimeAsync(0)

    expect(errors).toHaveBeenCalledWith(expect.stringContaining('final checkpoint wrote nothing (error)'))
    errors.mockRestore()
  })

  it('stays quiet when the final checkpoint had nothing to write', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const commit = vi.fn().mockResolvedValue({ outcome: 'clean', committed: false })
    const s = make(commit)

    s.onDisconnect('node:1', 0)
    await vi.advanceTimersByTimeAsync(0)

    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('stop() clears timers', async () => {
    const commit = vi.fn().mockResolvedValue(ok)
    const s = make(commit)
    s.onActivity('node:1')
    s.stop('node:1')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(commit).not.toHaveBeenCalled()
  })

  it('waitIdle resolves immediately for an unknown or idle document', async () => {
    const s = make(vi.fn().mockResolvedValue(ok))
    await expect(s.waitIdle('node:unknown')).resolves.toBeUndefined()
    s.onActivity('node:1')
    await expect(s.waitIdle('node:1')).resolves.toBeUndefined()
  })

  it('waitIdle blocks until an in-flight commit finishes', async () => {
    let release!: () => void
    const commit = vi.fn().mockImplementation(() => new Promise<CommitResult>((r) => { release = () => r(ok) }))
    const s = make(commit)

    s.onDisconnect('node:1', 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(commit).toHaveBeenCalledTimes(1)

    let settled = false
    const waiting = s.waitIdle('node:1').then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)

    release()
    await waiting
    expect(settled).toBe(true)
  })

  it('waitIdle survives a failing commit', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const commit = vi.fn().mockRejectedValue(new Error('drupal down'))
    const s = make(commit)
    s.onDisconnect('node:1', 0)
    await expect(s.waitIdle('node:1')).resolves.toBeUndefined()
  })

  it('a caller waiting on a commit runs under continuous editing, exactly once', async () => {
    // Revert, Publish, Approve and Save all queue here with somebody holding an
    // HTTP response open, while the timers keep re-arming underneath them.
    const releases: Array<() => void> = []
    const commit = vi.fn().mockImplementation(
      () => new Promise<CommitResult>((r) => { releases.push(() => r(ok)) }),
    )
    const s = make(commit)

    s.onActivity('node:1')
    await vi.advanceTimersByTimeAsync(1000) // quiet fires → one commit in flight
    expect(commit).toHaveBeenCalledTimes(1)

    let done = false
    const manual = s.checkpoint('node:1', 'manual', { cookie: 'SESS-ada' }).then(() => { done = true })

    for (let t = 0; t < 60_000; t += 500) {
      s.onActivity('node:1')
      await vi.advanceTimersByTimeAsync(500)
    }
    expect(commit).toHaveBeenCalledTimes(1)
    expect(done).toBe(false)

    releases[0]!()
    await vi.advanceTimersByTimeAsync(0)
    expect(commit).toHaveBeenLastCalledWith('node:1', 'manual', { cookie: 'SESS-ada' })

    releases[1]!()
    await manual
    expect(done).toBe(true)
    expect(commit).toHaveBeenCalledTimes(2)
  })

  it('two callers run one after the other, never together', async () => {
    const releases: Array<() => void> = []
    const commit = vi.fn().mockImplementation(
      () => new Promise<CommitResult>((r) => { releases.push(() => r(ok)) }),
    )
    const s = make(commit)

    const first = s.checkpoint('node:1', 'manual', { cookie: 'SESS-ada' })
    const second = s.checkpoint('node:1', 'agent', { token: 'agent-token' })
    await vi.advanceTimersByTimeAsync(0)
    expect(commit).toHaveBeenCalledTimes(1)

    releases[0]!()
    await first
    await vi.advanceTimersByTimeAsync(0)
    expect(commit).toHaveBeenCalledTimes(2)

    releases[1]!()
    await second
    expect(commit).toHaveBeenNthCalledWith(2, 'node:1', 'agent', { token: 'agent-token' })
  })
})
