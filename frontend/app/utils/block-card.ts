import { REVIEW_STEPS, type Approval, type BlockByline, type ReviewStep } from '#shared/page-blocks'
import { contributorName, signedOn, stepStateOf, type StepState } from './block-byline'

/**
 * The read page's per-block card — the presentation layer over the same
 * `BlockByline` the margin byline is built from.
 *
 * The byline says who wrote the block and whether anybody signed it off. The
 * card adds the other contributors and one row per step with something to
 * report; {@link stepStateOf} decides which those are, so the card and the
 * byline strip cannot drift. A space asking for nothing gets no rows.
 *
 * Kept out of the component for the reason `block-byline.ts` is: the wording
 * rules are what is worth pinning, and they pin as plain functions.
 *
 * A sign-off describes the block as it now reads — an edit re-stamps the flag
 * — so the approved revision id the sidecar records adds nothing to `signed`.
 */

/** One step's row in the card. */
export interface CardStepRow {
  step: ReviewStep
  state: StepState
  /** "Agent review" / "Peer review" — the step, not its outcome. */
  title: string
  /** The outcome, as a sentence: who signed it off, or what is being waited on. */
  detail: string
}

/** One block's card, ready to render. */
export interface BlockCardView {
  /** Everyone who touched the block, most recent edit first. */
  contributors: string[]
  /** The steps with something to report, in `REVIEW_STEPS` order. */
  steps: CardStepRow[]
}

/** How each step names itself. */
const STEP_TITLE: Record<ReviewStep, string> = {
  peer: 'Peer review',
  agent: 'Agent review',
}

function signedBy(approval: Approval): string {
  return `${approval.name?.trim() || 'Unknown'} on ${signedOn(approval.at)}`
}

function detailFor(state: StepState, approval: Approval | undefined): string {
  if (state === 'awaiting') return 'Awaiting sign-off — publishing waits for it'
  return approval ? `Signed off by ${signedBy(approval)}` : 'Signed off'
}

/**
 * Projects a block's byline into the card.
 *
 * @param byline
 *   The block as the read page was served it.
 * @param enforced
 *   The review steps this page's space enforces. Null (a reader's session,
 *   which is told no policy) enforces nothing: recorded sign-offs still show,
 *   and nothing is claimed about publishing.
 */
export function blockCardView(
  byline: BlockByline,
  enforced: readonly ReviewStep[] | null = null,
  viewerUid: number | null = null,
): BlockCardView {
  const steps: CardStepRow[] = []
  for (const step of REVIEW_STEPS) {
    const state = stepStateOf(byline, step, enforced ?? [])
    if (state === null) continue
    steps.push({ step, state, title: STEP_TITLE[step], detail: detailFor(state, byline.review[step]) })
  }
  return { contributors: byline.contributors.map(contributor => contributorName(contributor, viewerUid)), steps }
}
