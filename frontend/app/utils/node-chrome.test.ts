import { describe, it, expect } from 'vitest'
import { syncChipView, foldAwaitingBlocks } from './node-chrome'

/**
 * The editable-node chrome derivations (OKB-128).
 *
 * These are the pure views the sync chip and the review drawer read; pinning
 * them here keeps the wording out of the components that only render them.
 */

describe('syncChipView', () => {
  it('names each failed live status with a lock or offline cue', () => {
    expect(syncChipView('auth-error', undefined)).toMatchObject({ label: 'Not signed in', color: 'error', spin: false })
    expect(syncChipView('no-access', undefined)).toMatchObject({ label: 'No edit access', color: 'error' })
    expect(syncChipView('offline', undefined)).toMatchObject({ label: 'Offline', color: 'warning' })
  })

  it('spins only while connecting', () => {
    expect(syncChipView('connecting', undefined)).toMatchObject({ color: 'info', spin: true })
    expect(syncChipView('synced', '2m').spin).toBe(false)
  })

  it('folds the last-saved time into the synced label when there is one', () => {
    expect(syncChipView('synced', '2m').label).toBe('Synced · 2m')
    expect(syncChipView('synced', undefined).label).toBe('Synced')
  })

  it('reflects the commit lane once the socket is healthy', () => {
    expect(syncChipView('synced', '2m', 'saving')).toMatchObject({ label: 'Saving…', color: 'info', spin: true })
    expect(syncChipView('synced', '2m', 'dirty')).toMatchObject({ label: 'Unsaved changes', color: 'warning' })
    expect(syncChipView('synced', '2m', 'error', 'Conflict')).toMatchObject({ label: 'Conflict', color: 'error' })
    expect(syncChipView('synced', '2m', 'saved').label).toBe('Synced · 2m')
  })

  it('lets a broken live status win over any commit state', () => {
    expect(syncChipView('offline', '2m', 'dirty')).toMatchObject({ label: 'Offline', color: 'warning' })
    expect(syncChipView('auth-error', '2m', 'saving')).toMatchObject({ label: 'Not signed in', color: 'error' })
  })
})

describe('foldAwaitingBlocks', () => {
  it('adds a refusal-only block to the sidecar list', () => {
    const merged = foldAwaitingBlocks({ a: ['peer'] }, [{ item: 'b', steps: ['agent'] }])
    expect(merged).toEqual({ a: ['peer'], b: ['agent'] })
  })

  it('keeps the sidecar steps for a block both name', () => {
    const merged = foldAwaitingBlocks({ a: ['peer'] }, [{ item: 'a', steps: ['agent'] }])
    expect(merged.a).toEqual(['peer'])
  })

  it('is the sidecar unchanged when nothing was refused', () => {
    expect(foldAwaitingBlocks({ a: ['peer'] }, [])).toEqual({ a: ['peer'] })
  })
})
