import { describe, it, expect } from 'vitest'
import { blockByline, type PageBlock } from '#shared/page-blocks'
import { blockCardView } from './block-card'

/** A block as Drupal's presave would have left it. */
function block(entry: Partial<PageBlock>): PageBlock {
  return { contributors: [], ...entry }
}

/** The card for one block, under an optionally-known policy. */
function card(entry: Partial<PageBlock>, enforced: ('peer' | 'agent')[] | null = null) {
  return blockCardView(blockByline(block(entry)), enforced)
}

/** The row for one step, or undefined when the step earned none. */
function row(view: ReturnType<typeof card>, step: 'peer' | 'agent') {
  return view.steps.find(s => s.step === step)
}

const WRITTEN = {
  contributors: [
    { uid: 3, via: null, name: 'fago', lastEdit: 1000 },
    { uid: 7, via: 'Claude', name: 'ada', lastEdit: 2000 },
  ],
}

describe('blockCardView', () => {
  it('names everyone who touched the block, latest edit first', () => {
    expect(card(WRITTEN).contributors).toEqual(['ada via Claude', 'fago'])
  })

  it('names nobody for a block that attributes nobody', () => {
    expect(card({}).contributors).toEqual([])
  })

  it('blockCardView reads an enforced pending step as awaiting', () => {
    const view = card({ 'pending:agent': { by: [3], ok: [] } }, ['agent'])

    expect(row(view, 'agent')!.state).toBe('awaiting')
    expect(row(view, 'agent')!.detail).toBe('Awaiting sign-off — publishing waits for it')
  })

  it('blockCardView reads a recorded sign-off as signed and names the signer', () => {
    const view = card({ 'review:peer': { uid: 9, name: 'signer', at: 0, vid: 4 } })

    expect(row(view, 'peer')!.state).toBe('signed')
    expect(row(view, 'peer')!.detail).toContain('Signed off by signer')
  })

  it('blockCardView prefers the pending flag over an older sign-off', () => {
    const view = card({
      'pending:peer': { by: [3], ok: [] },
      'review:peer': { uid: 9, name: 'signer', at: 0, vid: 4 },
    }, ['peer'])

    expect(row(view, 'peer')!.state).toBe('awaiting')
    expect(row(view, 'peer')!.detail).not.toContain('signer')
  })

  describe('blockCardView step rows', () => {
    it('drops a step with neither flag nor sign-off', () => {
      expect(card(WRITTEN, ['agent', 'peer']).steps).toEqual([])
    })

    it('drops a flag the space does not enforce', () => {
      // Presave stamps `pending:peer` on every write and a wiki space
      // publishes past it, so the flag is bookkeeping and earns no row.
      expect(card({ 'pending:peer': { by: [3], ok: [] } }, ['agent']).steps).toEqual([])
    })

    it('keeps only the signed rows when the session was told no policy', () => {
      const view = card({
        'pending:agent': { by: [3], ok: [] },
        'review:peer': { uid: 9, name: 'signer', at: 0, vid: 4 },
      }, null)

      expect(view.steps.map(s => s.step)).toEqual(['peer'])
      expect(row(view, 'peer')!.state).toBe('signed')
    })

    it('keeps the contributors when the space enforces nothing', () => {
      const view = card({ ...WRITTEN, 'pending:peer': { by: [3], ok: [] } }, [])

      expect(view.contributors).toEqual(['ada via Claude', 'fago'])
      expect(view.steps).toEqual([])
    })
  })
})
