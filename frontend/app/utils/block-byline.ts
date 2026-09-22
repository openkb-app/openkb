import { REVIEW_STEPS, type BlockByline, type Contributor, type ReviewStep } from '#shared/page-blocks'
import { ownedLabel } from '#shared/utils/attribution'

/**
 * Read-page byline copy for one block — the presentation layer over the
 * `BlockByline` the CE-enrich splice ships on `content.props`.
 *
 * Kept out of the component so the wording rules (who is named, what a block
 * still owes, when there is nothing worth showing) unit-test as plain
 * functions; the component only positions what this returns.
 *
 * Nothing here decides anything: the flags and the sign-offs are facts Drupal
 * wrote and this reads. In particular there is no staleness to work out — a
 * sign-off that content moved under was dropped by the write that moved it, so
 * what arrives is already the truth about the block as it reads now.
 */

/** Where one review step stands, on any surface that shows it. */
export type StepState = 'awaiting' | 'signed'

/** How one review step reads to a reader. */
export interface StepView {
  step: ReviewStep
  /** 'awaiting' while the step is pending, 'signed' once it is not. */
  state: StepState
  label: string
}

/** One block's byline, ready to render. */
export interface BylineView {
  /** Every contributor named ("fago" / "fago via claude"), latest edit first. */
  contributors: string[]
  /** The review steps this block has anything to say about. */
  steps: StepView[]
  /** True where any contributor worked through an agent — what the brand's
      agent colour marks on the read page. */
  agentAuthored: boolean
}

/**
 * How a contributor is named, as the presence strip names a peer: an agent by
 * its owner, the viewer's own as theirs. An actor with no captured display name
 * is "Unknown" rather than blank — the contribution it stands for is real.
 */
export function contributorName(contributor: Contributor, viewerUid: number | null = null): string {
  const name = contributor.name?.trim() || 'Unknown'
  return ownedLabel({ uid: contributor.uid, name, via: contributor.via }, viewerUid)
}

/** Short absolute date for a sign-off; the byline is not a live feed. */
/** The day a sign-off was recorded. `at` is Drupal's seconds, not JS's ms. */
export function signedOn(at: number): string {
  return new Date(at * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** What each step asks for, in the words a reader needs. */
const AWAITING: Record<ReviewStep, string> = {
  peer: 'Awaiting review',
  agent: 'Agent edit awaiting a human',
}

/**
 * Whether one step is worth showing, and how it reads. The byline strip and
 * the block card share this rule so the two cannot drift.
 *
 * A step gets a row when publishing waits on it (its flag stands and the space
 * enforces it), or when a sign-off is on record. Otherwise none: the sidecar
 * keeps flags for steps the space does not enforce, and a step with neither
 * flag nor record has nothing to report.
 *
 * `enforced` is what the space asks for; an empty list leaves the signed rows
 * and nothing else.
 */
export function stepStateOf(
  byline: BlockByline,
  step: ReviewStep,
  enforced: readonly ReviewStep[],
): StepState | null {
  if (byline.pending.includes(step)) return enforced.includes(step) ? 'awaiting' : null
  return byline.review[step] ? 'signed' : null
}

/**
 * Projects a block's record into byline copy, under the space's policy.
 *
 * Which steps get a row is {@link stepStateOf}'s call; this only words them.
 *
 * Defaults to every step, the same fail-closed posture `enforcedSteps(null)`
 * takes: a surface that cannot establish the policy says what publishing might
 * be waiting for rather than quietly saying nothing.
 */
export function bylineView(
  byline: BlockByline,
  enforced: readonly ReviewStep[] = REVIEW_STEPS,
  viewerUid: number | null = null,
): BylineView {
  const contributors = byline.contributors.map(contributor => contributorName(contributor, viewerUid))
  const steps: StepView[] = []
  for (const step of REVIEW_STEPS) {
    const state = stepStateOf(byline, step, enforced)
    if (state === null) continue
    if (state === 'awaiting') {
      steps.push({ step, state, label: AWAITING[step] })
      continue
    }
    const signed = byline.review[step]!
    steps.push({ step, state, label: `Reviewed by ${signed.name?.trim() || 'Unknown'} on ${signedOn(signed.at)}` })
  }
  return { contributors, steps, agentAuthored: byline.contributors.some(c => !!c.via) }
}

/**
 * The accessible name of the control that opens a block's card.
 *
 * The button carries no text, so this name is all a screen reader gets. It
 * names the contributors, otherwise a page of these reads as a list of
 * identical controls, and says "Review" only where the card shows a review row.
 */
export function bylineTriggerLabel(view: BylineView): string {
  const who = view.contributors.join(', ')
  if (view.steps.length > 0) {
    return who ? `Review and authorship of the block by ${who}` : 'Review and authorship of this block'
  }
  return who ? `About this block — edited by ${who}` : 'About this block'
}
