import { isPending, REVIEW_STEPS, type BlockMetaMap, type ReviewStep } from '#shared/page-blocks'

/**
 * The moderation surface of one page, shared by the server proxy and the
 * chrome that renders it (OKB-84).
 *
 * The status is Drupal's answer in full — including whether this session may
 * publish and which review steps its space enforces — so the control the UI
 * shows and the write it performs are gated by one decision. Nothing here
 * infers permission, and nothing here decides policy.
 */

/** What Drupal's `/openkb/node/<nid>/moderation` answers. */
export interface ModerationStatus {
  nid: number
  /**
   * FALSE means render no moderation chrome at all — not disabled chrome.
   * Moderation becomes a per-space setting in OKB-86; this boolean is the
   * whole of what the UI has to follow when it does.
   */
  moderated: boolean
  /** Working-copy state (`draft` / `in_review` / `published`), or null. */
  state: string | null
  /** Whether anything is live — false on a never-published page. */
  hasPublishedRevision: boolean
  /** Whether a forward draft sits on top of the published revision. */
  hasUnpublishedChanges: boolean
  /** Whether this session may run the publish transition from that state. */
  canPublish: boolean
  /**
   * Whether this session may sign a block off past the four-eyes rule — the
   * ADR 0002 admin exception (\Drupal\openkb_workflow\ReviewPolicy::mayModerate).
   *
   * The editor derives, per block, whether the reader may clear it; without
   * this it would tell an admin their own writing needs somebody else's eyes.
   * An absent status reads as FALSE, which withholds an offer rather than
   * making one that Drupal would refuse.
   */
  mayModerate: boolean
  /**
   * The review steps that hold a publication up in this page's space —
   * the publish gate's own policy, so the chrome filters the sidecar's flags
   * by exactly what Drupal will refuse on.
   *
   * Independent of `moderated`: a wiki space reports `moderated: false` and
   * can still enforce `agent`, which is the space where it matters most.
   */
  reviewSteps: ReviewStep[]
  /**
   * The blocks holding a publish back, as block id => the steps they owe.
   * Empty when nothing does.
   */
  reviewBlockers: Record<string, ReviewStep[]>
  /**
   * Why a publish is refused right now, in Drupal's own words — what the
   * greyed Publish control says. NULL when nothing holds it.
   */
  publishBlockedReason: string | null
}

/**
 * Whether there is a draft for the chrome to describe.
 *
 * `moderated` is the space's policy, not the page's condition, and the two
 * come apart in exactly the state that needs saying most: a wiki space asks
 * for no review before publishing, so it reports `moderated: false` — but a
 * save, a publish the gate held back, or a disconnect checkpoint all leave a
 * forward draft there. Keying the chrome on the policy hides that draft
 * entirely: the read page looks live while it is not, and the actions that
 * would flush it are the ones being hidden.
 *
 * So the chrome follows the condition. A space with no draft renders nothing
 * either way, which is what makes moderation-off look like moderation-off.
 */
export function describesADraft(status: ModerationStatus | null): status is ModerationStatus {
  return !!status && (status.moderated || status.hasUnpublishedChanges)
}

/** A badge the chrome renders. */
export interface ModerationBadge {
  label: string
  color: 'success' | 'warning' | 'info' | 'neutral'
  icon: string
  /**
   * Whether the badge links into edit mode.
   *
   * Set only on the badge that describes a draft the reader could go and work
   * on, and only for a session that may edit — a link a reader cannot follow is
   * a 403 dressed as an invitation. The chrome owns the href (the edit surface
   * is a query on the page's own route, not a route of its own).
   */
  linkToEdit?: true
}

const STATE_LABELS: Record<string, string> = {
  draft: 'Draft',
  in_review: 'In review',
  published: 'Published',
}

/**
 * A moderation state in the words the app uses for it.
 *
 * One vocabulary for every surface that names a state — the chrome's badge, the
 * revision rows — so nobody has to work out that "in_review" and "In review"
 * are the same thing. An unknown state comes back as it came: Drupal's own id
 * beats a guess.
 */
export function stateLabel(state: string | null | undefined): string | null {
  if (!state) return null
  return STATE_LABELS[state] ?? state
}

/**
 * Where a page stands, as one badge.
 *
 * One fact, one badge, and the states are exclusive:
 *
 *  - **Draft** — never published. The page is not live at all.
 *  - **In review** — a draft on the live page, submitted for review.
 *  - **Unpublished changes** — a draft on the live page. Links into edit mode
 *    for a session that may edit, because working on it is what the badge is
 *    telling the reader about.
 *  - **Published** — the working copy IS the live page.
 *
 * "Draft" and "Unpublished changes" are never both true: the first says the
 * page is not live, the second says it is.
 *
 * An unmoderated page with nothing pending has no badge: absence of
 * moderation is absence of chrome.
 */
export function moderationBadges(
  status: ModerationStatus | null,
  mayEdit = false,
): ModerationBadge[] {
  if (!describesADraft(status)) return []

  // Nothing live: whatever the working copy is called, the page is a draft.
  if (!status.hasPublishedRevision) {
    return [{ label: STATE_LABELS.draft!, color: 'warning', icon: 'i-lucide-pencil-line' }]
  }
  // The workflow still carries `in_review`, and a revision can hold it.
  if (status.state === 'in_review') {
    return [{ label: STATE_LABELS.in_review!, color: 'info', icon: 'i-lucide-eye' }]
  }
  if (status.hasUnpublishedChanges) {
    return [{
      label: 'Unpublished changes',
      color: 'warning',
      icon: 'i-lucide-clock',
      ...(mayEdit ? { linkToEdit: true as const } : {}),
    }]
  }
  return [{ label: STATE_LABELS.published!, color: 'success', icon: 'i-lucide-globe' }]
}

/**
 * Whether Publish would do anything.
 *
 * `canPublish` is the right — Drupal's, per page and per account. The
 * condition is what the page says: a working copy that is already the live
 * page has nothing to publish, and offering it would write a revision that
 * changes nothing. That is the state a revert leaves behind, a draft holding
 * the published content.
 *
 * `pendingEdits` is the live session's unsaved state, which the status cannot
 * know about: Drupal has not seen those keystrokes yet, so it reports the
 * page as unchanged while the editor is looking at changes. Publishing is
 * how they expect to put those on the page, and the endpoint checkpoints
 * before transitioning precisely so it can.
 */
export function canPublishNow(
  status: ModerationStatus | null,
  pendingEdits = false,
): boolean {
  if (!status?.canPublish) return false
  return status.hasUnpublishedChanges || !status.hasPublishedRevision || pendingEdits
}

/**
 * Why Publish would be refused, or NULL when it would go through.
 *
 * {@link awaitingReview} decides, so a sign-off made after the status was read
 * reopens the control. Drupal's own sentence is the wording when it has one, so
 * the button says what the 422 would.
 */
export function publishRefusal(
  status: ModerationStatus | null,
  awaiting = 0,
): string | null {
  if (awaiting === 0) return null
  return status?.publishBlockedReason ?? `${awaiting} change(s) are waiting for review.`
}

/**
 * Whether Revert-to-published has something to restore: a live revision, and a
 * draft sitting on top of it that differs.
 */
export function canRevertNow(status: ModerationStatus | null): boolean {
  return describesADraft(status) && status.hasPublishedRevision && status.hasUnpublishedChanges
}

/**
 * The review steps to filter the sidecar's flags by — the space's policy as a
 * set. Which steps it asks for, never the order they read in: that belongs to
 * {@link REVIEW_STEPS}, and {@link blockers} applies it.
 *
 * Returns the status's own array rather than a copy, because this is called
 * from render and the editor watches the result: a fresh array per call is a
 * fresh identity per render, and the watch that re-projects the marks would
 * feed its own next render.
 *
 * A status that could not be read enforces both — the same fail-closed posture
 * \Drupal\openkb_workflow\ReviewPolicy takes, so a surface that cannot establish
 * the policy reports what publishing *might* be waiting for rather than
 * quietly reporting nothing.
 */
export function enforcedSteps(status: ModerationStatus | null): readonly ReviewStep[] {
  return status?.reviewSteps ?? REVIEW_STEPS
}

/**
 * Whether this session may moderate past the four-eyes rule.
 *
 * Fails the other way from {@link enforcedSteps}, and for the same reason both
 * are right: an unreadable policy must not hide what publishing waits for, and
 * must not offer a sign-off Drupal would refuse.
 */
export function mayModerate(status: ModerationStatus | null): boolean {
  return status?.mayModerate ?? false
}

/**
 * The blocks holding this publication up: block id → the steps it owes.
 *
 * Two witnesses, reconciled per block. The sidecar the collab server mirrors
 * in is the newer one about every block it holds an entry for — it carries
 * this session's own edits before any checkpoint, and a sign-off before the
 * next status read — so where it speaks, it decides. Where it says nothing,
 * Drupal's own list stands: a session whose collaboration document has not
 * synced yet knows of no flag at all, and reading that as "nothing is waiting"
 * would paint the control live on a page the gate would refuse.
 *
 * Neither witness invents: the mirror flags only blocks it saw change, so a
 * block the editor keeps but Drupal stores nothing for never reaches this list.
 */
export function awaitingReview(
  meta: BlockMetaMap,
  status: ModerationStatus | null,
): Record<string, ReviewStep[]> {
  const steps = enforcedSteps(status)
  const named = status?.reviewBlockers ?? {}
  const out: Record<string, ReviewStep[]> = {}
  for (const id of [...new Set([...Object.keys(meta), ...Object.keys(named)])].sort()) {
    const witnessed = meta[id]
    const owed = REVIEW_STEPS.filter(step => steps.includes(step) && (witnessed === undefined
      ? (named[id] ?? []).includes(step)
      : isPending(witnessed, step)))
    if (owed.length > 0) out[id] = owed
  }
  return out
}
