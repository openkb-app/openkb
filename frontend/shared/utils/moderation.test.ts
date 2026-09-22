import { describe, it, expect } from 'vitest'
import {
  awaitingReview,
  canPublishNow,
  canRevertNow,
  describesADraft,
  publishRefusal,
  enforcedSteps,
  moderationBadges,
  type ModerationStatus,
} from './moderation'
import type { PageBlock, BlockMetaMap } from '#shared/page-blocks'

/**
 * Pins what the chrome renders per moderation standing (OKB-84).
 *
 * These are the states an editor has to be able to tell apart at a glance, so
 * they are asserted as states rather than as strings: a never-published draft
 * is not the same thing as a draft on a live page, and "published" with a
 * forward draft must not read as "everything you see is live".
 */

function status(overrides: Partial<ModerationStatus> = {}): ModerationStatus {
  return {
    nid: 7,
    moderated: true,
    state: 'published',
    hasPublishedRevision: true,
    hasUnpublishedChanges: false,
    canPublish: true,
    reviewSteps: ['peer', 'agent'],
    reviewBlockers: {},
    publishBlockedReason: null,
    ...overrides,
  }
}

/** A block owing the given steps, as Drupal stamps them. */
function owing(...steps: Array<'peer' | 'agent'>): PageBlock {
  const block: PageBlock = { contributors: [] }
  for (const step of steps) block[`pending:${step}` as 'pending:peer'] = { by: [3], ok: [] }
  return block
}

describe('moderationBadges', () => {
  it('renders nothing when the page is not moderated', () => {
    expect(moderationBadges(status({ moderated: false }))).toEqual([])
  })

  it('renders nothing when the status could not be read', () => {
    expect(moderationBadges(null)).toEqual([])
  })

  it('shows one Published badge for a live page with no pending draft', () => {
    const badges = moderationBadges(status())
    expect(badges).toHaveLength(1)
    expect(badges[0]).toMatchObject({ label: 'Published', color: 'success' })
  })

  it('shows one Unpublished-changes badge for a draft on a live page', () => {
    // Not "Draft" as well: the page IS live, which is exactly what "Draft"
    // denies. The two states are exclusive and the badge names the one that
    // holds.
    const badges = moderationBadges(status({ state: 'draft', hasUnpublishedChanges: true }))
    expect(badges).toHaveLength(1)
    expect(badges[0]).toMatchObject({ label: 'Unpublished changes', color: 'warning' })
  })

  it('shows Draft only when nothing has ever been published', () => {
    const badges = moderationBadges(status({
      state: 'draft',
      hasPublishedRevision: false,
      hasUnpublishedChanges: false,
    }))
    expect(badges).toHaveLength(1)
    expect(badges[0]).toMatchObject({ label: 'Draft', color: 'warning' })
  })

  it('labels the review state', () => {
    const badges = moderationBadges(status({ state: 'in_review', hasUnpublishedChanges: true }))
    expect(badges).toHaveLength(1)
    expect(badges[0]).toMatchObject({ label: 'In review', color: 'info' })
  })

  it('shows Published once a revert has put the working copy back on the live page', () => {
    // What a revert leaves: a draft revision holding the published content. It
    // is not "unpublished changes" — there are none — and offering to publish
    // or revert it again would name a write that changes nothing.
    const reverted = status({ state: 'draft', hasUnpublishedChanges: false })
    expect(moderationBadges(reverted)).toEqual([
      { label: 'Published', color: 'success', icon: 'i-lucide-globe' },
    ])
    expect(canRevertNow(reverted)).toBe(false)
    expect(canPublishNow(reverted)).toBe(false)
  })

  it('links the draft badge into edit mode only for a session that may edit', () => {
    const draft = status({ state: 'draft', hasUnpublishedChanges: true })
    expect(moderationBadges(draft, true)[0]!.linkToEdit).toBe(true)
    expect(moderationBadges(draft, false)[0]!.linkToEdit).toBeUndefined()
    expect(moderationBadges(draft)[0]!.linkToEdit).toBeUndefined()
  })

  it('never links a badge that is not about a draft to work on', () => {
    expect(moderationBadges(status(), true)[0]!.linkToEdit).toBeUndefined()
    expect(moderationBadges(status({ state: 'in_review', hasUnpublishedChanges: true }), true)[0]!.linkToEdit)
      .toBeUndefined()
    expect(moderationBadges(status({ hasPublishedRevision: false, state: 'draft' }), true)[0]!.linkToEdit)
      .toBeUndefined()
  })
})

describe('describesADraft', () => {
  /** A wiki space: reviews nothing before publishing, so moderation reads off. */
  const wiki = (overrides: Partial<ModerationStatus> = {}) =>
    status({ moderated: false, ...overrides })

  it('is false for a wiki page with nothing held back', () => {
    expect(describesADraft(wiki({ state: null, hasUnpublishedChanges: false }))).toBe(false)
    expect(moderationBadges(wiki({ state: null, hasUnpublishedChanges: false }))).toEqual([])
  })

  it('sees the forward draft a wiki page carries anyway', () => {
    // A disconnect checkpoint leaves one, and the space's policy says nothing
    // about whether it exists — an unseen draft is a live-looking page that is
    // not live, with the actions that would flush it hidden too.
    const held = wiki({ state: 'draft', hasUnpublishedChanges: true })
    expect(describesADraft(held)).toBe(true)
    expect(moderationBadges(held).map(badge => badge.label))
      .toEqual(['Unpublished changes'])
    expect(canRevertNow(held)).toBe(true)
  })
})

describe('canPublishNow', () => {
  it('is false without the transition, whatever the state', () => {
    expect(canPublishNow(status({ state: 'draft', canPublish: false, hasUnpublishedChanges: true }))).toBe(false)
  })

  it('is false on a published page with nothing pending — the write would change nothing', () => {
    expect(canPublishNow(status())).toBe(false)
  })

  it('is true with a forward draft to promote', () => {
    expect(canPublishNow(status({ hasUnpublishedChanges: true }))).toBe(true)
  })

  it('is true for a never-published draft', () => {
    expect(canPublishNow(status({ state: 'draft', hasPublishedRevision: false }))).toBe(true)
  })

  it('is true in a space that reviews nothing, where Publish is the only way live', () => {
    expect(canPublishNow(status({ moderated: false, state: 'draft', hasUnpublishedChanges: true }))).toBe(true)
  })

  it('offers itself for unsaved session edits Drupal has not seen yet', () => {
    // The editor has typed but not saved: the status still reports a clean
    // published page, and hiding Publish would leave them with no way to
    // put what they are looking at on the page.
    expect(canPublishNow(status(), true)).toBe(true)
  })

  it('still respects the transition grant for unsaved edits', () => {
    expect(canPublishNow(status({ canPublish: false }), true)).toBe(false)
  })
})

describe('publishRefusal', () => {
  it('is the sentence Drupal would answer with when a block is waiting', () => {
    const reason = '1 change(s) are waiting for review: b-one.'
    expect(publishRefusal(status({ publishBlockedReason: reason }), 1)).toBe(reason)
  })

  it('names the blocks this session flagged since the status was read', () => {
    // A block flagged a keystroke ago holds a publish just as one Drupal
    // already knows about.
    expect(publishRefusal(status(), 2)).toBe('2 change(s) are waiting for review.')
  })

  it('is null when nothing is waiting', () => {
    expect(publishRefusal(status())).toBeNull()
  })

  it('lets a sign-off since the status was read reopen the control', () => {
    // The status is a read; a sign-off after it clears the sidecar the editor
    // mirrors. Without this the control stays shut for the rest of the
    // session.
    const reason = '1 change(s) are waiting for review: b-one.'
    expect(publishRefusal(status({ publishBlockedReason: reason }), 0)).toBeNull()
  })
})

describe('canRevertNow', () => {
  it('needs both a live revision and a draft on top of it', () => {
    expect(canRevertNow(status({ hasUnpublishedChanges: true }))).toBe(true)
    expect(canRevertNow(status())).toBe(false)
    expect(canRevertNow(status({ hasPublishedRevision: false, hasUnpublishedChanges: true }))).toBe(false)
  })

  it('does not depend on the publish transition — reverting is not publishing', () => {
    expect(canRevertNow(status({ hasUnpublishedChanges: true, canPublish: false }))).toBe(true)
  })
})

/**
 * The publish gate as the editor chrome reads it (OKB-121).
 *
 * The client derives to disable a button and fill a drawer; Drupal derives to
 * refuse the write. These pin the client half against the same rule, including
 * the two places where reading it loosely would let a page publish unreviewed:
 * a space that enforces one step and not the other, and a policy that could
 * not be read at all.
 */
describe('enforcedSteps', () => {
  it('follows the space policy the status carries', () => {
    expect(enforcedSteps(status({ reviewSteps: ['agent'] }))).toEqual(['agent'])
  })

  // Called from render and watched by the editor, so the same policy must come
  // back as the same array — a copy per call is a new identity per render.
  it('hands back the status\'s own array, not a copy of it', () => {
    const carried = status({ reviewSteps: ['peer', 'agent'] })
    expect(enforcedSteps(carried)).toBe(carried.reviewSteps)
    expect(enforcedSteps(null)).toBe(enforcedSteps(null))
  })

  it('enforces both when the status could not be read — fail closed', () => {
    expect(enforcedSteps(null)).toEqual(['agent', 'peer'])
  })

  it('enforces nothing when the space enforces nothing', () => {
    expect(enforcedSteps(status({ reviewSteps: [] }))).toEqual([])
  })
})

describe('awaitingReview', () => {
  const meta: BlockMetaMap = {
    'b-1': owing('peer'),
    'b-2': owing('agent'),
    'b-3': owing('peer', 'agent'),
    'b-4': { contributors: [] },
  }
  /** The blockers Drupal names for `meta`, with every step enforced. */
  const named = { 'b-1': ['peer'], 'b-2': ['agent'], 'b-3': ['agent', 'peer'] } as const

  it('names every block owing an enforced step, and the steps it owes', () => {
    expect(awaitingReview(meta, status({ reviewBlockers: { ...named } }))).toEqual({
      'b-1': ['peer'],
      'b-2': ['agent'],
      'b-3': ['agent', 'peer'],
    })
  })

  it('drops a step the space does not enforce', () => {
    // A wiki space: saves publish on the spot, so a second pair of eyes on one
    // would block nothing — but unreviewed agent text still must not go live.
    const wiki = status({
      moderated: false,
      reviewSteps: ['agent'],
      reviewBlockers: { 'b-2': ['agent'], 'b-3': ['agent'] },
    })
    expect(awaitingReview(meta, wiki)).toEqual({
      'b-2': ['agent'],
      'b-3': ['agent'],
    })
  })

  it('holds an unmoderated space to its agent step all the same', () => {
    const wiki = status({
      moderated: false,
      reviewSteps: ['agent'],
      reviewBlockers: { 'b-2': ['agent'] },
    })
    expect(Object.keys(awaitingReview({ 'b-2': owing('agent') }, wiki))).toEqual(['b-2'])
  })

  it('says nothing about a block with no flag — never an unearned tick', () => {
    expect(awaitingReview({ 'b-4': { contributors: [] } }, status())).toEqual({})
  })

  it('names a block the sidecar flagged that Drupal has not been told about', () => {
    // An edit before any checkpoint: the mirror is the only witness of it, and
    // publishing would checkpoint it and then be refused on it.
    const typedIn = { ...meta, 'b-5': owing('peer') }
    expect(Object.keys(awaitingReview(typedIn, status({ reviewBlockers: { ...named } }))))
      .toEqual(['b-1', 'b-2', 'b-3', 'b-5'])
  })

  it('takes a block off the list once the sidecar reports it signed off', () => {
    const signedOff = { ...meta, 'b-1': { contributors: [] } }
    expect(awaitingReview(signedOff, status({ reviewBlockers: { ...named } }))).toEqual({
      'b-2': ['agent'],
      'b-3': ['agent', 'peer'],
    })
  })

  it('keeps Drupal\'s word on a block the sidecar says nothing about yet', () => {
    // Before the collaboration document syncs there is no sidecar to read, and
    // reading that as "nothing is waiting" would paint the control live.
    expect(awaitingReview({}, status({ reviewBlockers: { ...named } }))).toEqual({
      'b-1': ['peer'],
      'b-2': ['agent'],
      'b-3': ['agent', 'peer'],
    })
  })

  it('falls back to the sidecar when the status could not be read', () => {
    expect(awaitingReview(meta, null)).toEqual({
      'b-1': ['peer'],
      'b-2': ['agent'],
      'b-3': ['agent', 'peer'],
    })
  })
})
