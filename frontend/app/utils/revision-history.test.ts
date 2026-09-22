import { describe, it, expect } from 'vitest'
import { historyScope, revisionMarkers, type RevisionProps } from './revision-history'

/**
 * The revision history's wording rules (OKB-123).
 *
 * What is pinned here is the distinction the page exists to draw — the newest
 * revision and the live one are two different things, and on a page being
 * worked on they are two different rows.
 */

const revision = (props: Partial<RevisionProps> = {}): RevisionProps => ({
  vid: 7,
  created: '2026-08-03T09:00:00+00:00',
  ...props,
})

describe('revisionMarkers', () => {
  it('marks the live revision and the working copy apart', () => {
    expect(revisionMarkers(revision({ published: true })).map(m => m.label)).toEqual(['Live'])
    expect(revisionMarkers(revision({ current: true })).map(m => m.label)).toEqual(['Working copy'])
  })

  it('marks a revision that is both, and says both', () => {
    expect(revisionMarkers(revision({ current: true, published: true })).map(m => m.label))
      .toEqual(['Live', 'Working copy'])
  })

  it('leaves a superseded revision unmarked', () => {
    expect(revisionMarkers(revision({ state: 'published' }))).toEqual([])
  })
})

describe('historyScope', () => {
  it('stays quiet while the rows are the whole history', () => {
    expect(historyScope(3, 3)).toBeNull()
  })

  it('says what was left out once they are not', () => {
    expect(historyScope(50, 214)).toBe('Showing the 50 most recent of 214 revisions.')
  })
})
