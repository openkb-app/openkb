import { describe, it, expect } from 'vitest'
import { blockByline, type PageBlock } from '#shared/page-blocks'
import { spaceReviewSteps, type KbSpaceCeProp } from '#shared/utils/kb-spaces'
import { reviewMarkOf } from '../editor/review-marks'
import { bylineTriggerLabel, bylineView, contributorName, signedOn } from './block-byline'

/** A block as Drupal's presave would have left it. */
function block(entry: Partial<PageBlock>): PageBlock {
  return { contributors: [], ...entry }
}

const WRITTEN = block({
  contributors: [
    { uid: 3, via: null, name: 'fago', lastEdit: 1000 },
    { uid: 3, via: 'Claude', name: 'fago', lastEdit: 2000 },
  ],
})

describe('contributorName', () => {
  it('names a direct human edit', () => {
    expect(contributorName({ uid: 3, via: null, name: 'fago', lastEdit: 1 })).toBe('fago')
  })

  it('names an agent by its owner, and the viewer\'s own as theirs', () => {
    expect(contributorName({ uid: 3, via: 'Claude', name: 'fago', lastEdit: 1 }))
      .toBe('fago via Claude')
    expect(contributorName({ uid: 3, via: 'Claude', name: 'fago', lastEdit: 1 }, 3))
      .toBe('Claude')
  })

  it('falls back to Unknown rather than rendering half a sentence', () => {
    expect(contributorName({ uid: null, via: null, lastEdit: 1 })).toBe('Unknown')
    expect(contributorName({ uid: 3, via: 'Claude', name: '  ', lastEdit: 1 }))
      .toBe('Unknown via Claude')
  })
})

describe('bylineView', () => {
  it('names every contributor, agent included, latest edit first', () => {
    expect(bylineView(blockByline(WRITTEN)).contributors)
      .toEqual(['fago via Claude', 'fago'])
  })

  it('names nobody for a block that attributes nobody', () => {
    expect(bylineView(blockByline(block({}))).contributors).toEqual([])
  })

  it('marks a block an agent had a hand in', () => {
    expect(bylineView(blockByline(WRITTEN)).agentAuthored).toBe(true)
  })

  it('leaves a block only people wrote unmarked', () => {
    const human = block({ contributors: [{ uid: 3, via: null, name: 'fago', lastEdit: 1000 }] })
    expect(bylineView(blockByline(human)).agentAuthored).toBe(false)
    expect(bylineView(blockByline(block({}))).agentAuthored).toBe(false)
  })

  it('says a pending step is awaiting, and names what it waits for', () => {
    const view = bylineView(blockByline(block({
      'pending:peer': { by: [3], ok: [] },
      'pending:agent': { by: [3], ok: [] },
    })))

    expect(view.steps.map(s => [s.step, s.state])).toEqual([['agent', 'awaiting'], ['peer', 'awaiting']])
    expect(view.steps[0]!.label).toContain('human')
  })

  it('reads a completed step as signed, naming who signed it and when', () => {
    const view = bylineView(blockByline(block({
      'review:peer': { uid: 9, name: 'signer', at: 0, vid: 4 },
    })))

    expect(view.steps).toHaveLength(1)
    expect(view.steps[0]).toMatchObject({ step: 'peer', state: 'signed' })
    expect(view.steps[0]!.label).toContain('Reviewed by signer')
  })

  it('reports the flag, not the sign-off, once the block is pending again', () => {
    const view = bylineView(blockByline(block({
      'pending:peer': { by: [3], ok: [] },
      'review:peer': { uid: 9, name: 'signer', at: 0, vid: 4 },
    })))

    expect(view.steps).toEqual([{ step: 'peer', state: 'awaiting', label: 'Awaiting review' }])
  })

  it('says nothing at all about a step the block has no record for', () => {
    expect(bylineView(blockByline(WRITTEN)).steps).toEqual([])
  })
})

describe('bylineTriggerLabel', () => {
  const written = block({
    contributors: [{ uid: 3, via: null, name: 'editor1', lastEdit: 1000 }],
    'pending:peer': { by: [3], ok: [] },
  })

  it('bylineTriggerLabel says Review when the view has a step row', () => {
    expect(bylineTriggerLabel(bylineView(blockByline(written), ['peer'])))
      .toBe('Review and authorship of the block by editor1')
  })

  it('bylineTriggerLabel omits Review when the view has no step row', () => {
    expect(bylineTriggerLabel(bylineView(blockByline(written), ['agent'])))
      .toBe('About this block — edited by editor1')
  })

  it('bylineTriggerLabel falls back to a generic name with no contributors', () => {
    expect(bylineTriggerLabel(bylineView(blockByline(block({})), []))).toBe('About this block')
  })
})

/**
 * OKB-198: the read page and the editor answer the same question one way.
 *
 * The sidecar records a step's flag whether or not the space asks for it —
 * turning the policy on later has to find the history there — so both surfaces
 * filter by what the space enforces. A wiki space runs no peer review, and a
 * page saved there is live the moment it is saved: a byline reading "Awaiting
 * review" on it names a queue that is empty and a publication nothing is
 * holding up.
 */
describe('the read-page byline and the editor mark, under one policy', () => {
  const space = (moderation: boolean): KbSpaceCeProp => ({
    uuid: 'u', id: 1, name: 'Space', path: '/space', readAccess: 'all_users', moderation, agentReview: true,
  })
  /** What presave leaves on a block one person just wrote. */
  const written = block({
    contributors: [{ uid: 3, via: null, name: 'editor1', lastEdit: 1000 }],
    'pending:peer': { by: [3], ok: [] },
  })
  const reader = { uid: 9, isAdmin: false }

  it('says a peer review is owed in a space that runs one', () => {
    const steps = spaceReviewSteps(space(true))
    expect(steps).toEqual(['agent', 'peer'])
    expect(reviewMarkOf(written, steps, reader))
      .toEqual({ state: 'reviewable', steps: [{ step: 'peer', state: 'reviewable', refusal: null }] })
    expect(bylineView(blockByline(written), steps).steps)
      .toEqual([{ step: 'peer', state: 'awaiting', label: 'Awaiting review' }])
  })

  it('says nothing is owed in a wiki space, on both surfaces', () => {
    const steps = spaceReviewSteps(space(false))
    expect(steps).toEqual(['agent'])
    expect(reviewMarkOf(written, steps, reader)).toBeNull()
    expect(bylineView(blockByline(written), steps).steps).toEqual([])
    // The contributor is still named — who wrote it is not a review claim.
    expect(bylineView(blockByline(written), steps).contributors).toEqual(['editor1'])
  })

  it('keeps a sign-off that was actually given, whatever the space enforces', () => {
    const signed = block({
      contributors: [{ uid: 3, via: null, name: 'editor1', lastEdit: 1000 }],
      'review:peer': { uid: 9, name: 'reviewer', at: 1700000000, vid: 4 },
    })
    for (const steps of [spaceReviewSteps(space(true)), spaceReviewSteps(space(false))]) {
      expect(bylineView(blockByline(signed), steps).steps[0])
        .toMatchObject({ step: 'peer', state: 'signed' })
    }
  })

  // `at` is Drupal's request time in seconds. Read as milliseconds it lands in
  // January 1970 for every sign-off ever recorded.
  it('reads the sign-off time as seconds', () => {
    expect(signedOn(1700000000)).toContain('2023')
  })

  it('falls closed when the policy did not reach the page', () => {
    const steps = spaceReviewSteps(undefined)
    expect(steps).toEqual(['agent', 'peer'])
    expect(bylineView(blockByline(written)).steps)
      .toEqual(bylineView(blockByline(written), steps).steps)
  })
})
