import { reviewableCount, reviewQueue, unidentifiedBlocks, type ReviewQueueRow } from '~/editor/review-marks'
import { commentRows, type CommentThreadView } from '~/editor/comment-marks'
import { assignedCounts } from '~/editor/comment-assignee'
import { awaitingReview } from '#shared/utils/moderation'
import { foldAwaitingBlocks } from '~/utils/node-chrome'
import type { KbNodeEditSession } from '~/composables/useKbNodeEditSession'
import type { useModerationStatus } from '~/composables/useModerationStatus'

type Moderation = ReturnType<typeof useModerationStatus>

/**
 * The review gate (OKB-121): what an editable node still owes before it can
 * publish, and the surface that lists it. From `lg` that surface is the side
 * pane, so `reviewOpen` reads and writes the pane's own state.
 *
 * The blocks come from the status Drupal answered, taken off that list as the
 * mirrored sidecar reports them cleared — no fetch of its own, and never a
 * block Drupal did not name. The publish endpoint's own refusal settles a race.
 */
export function useKbReviewGate(editSession: KbNodeEditSession, moderation: Moderation) {
  const { session, editorInstance, mode, exitToRead, refreshPage, goToBlockId: goToCommentBlock } = editSession
  const { status: moderationStatus, publish, publishBlockers } = moderation

  const pane = useSidePane()
  /** The slideover's own state, below `lg` where there is no pane. */
  const drawerOpen = ref(false)
  /** Parked, not hidden: closing Review gives this page's pane back to the
   *  outline. Hiding the pane itself is the reader's control, remembered for
   *  every page. */
  const reviewParked = ref(false)

  /** Whether the review surface is on screen — one flag over two frames. From
   *  `lg` that is the pane showing what this page asked for, so asking for it
   *  also parks a chat the reader opened over it. */
  const reviewOpen = computed({
    get: () => (pane.wide.value
      ? pane.content.value === 'comments' && !pane.hidden.value
      : drawerOpen.value),
    set: (value) => {
      if (!pane.wide.value) {
        drawerOpen.value = value
        return
      }
      reviewParked.value = !value
      if (!value) return
      pane.parkChat()
      pane.show()
    },
  })

  // Closing Review is this edit session's decision, so leaving edit forgets it:
  // the next one opens on the review surface again.
  watch(mode, (now) => { if (now !== 'edit') reviewParked.value = false })

  /** Block id → the steps it owes: Drupal's list, narrowed by the sidecar. */
  const sidecarBlocks = computed(() =>
    session.value ? awaitingReview(session.value.blockMeta.value, moderationStatus.value) : {})

  /** The same, with the last refusal's blocks folded in — the listed set. */
  const awaitingBlocks = computed(() => foldAwaitingBlocks(sidecarBlocks.value, publishBlockers.value))

  // The refusal is worth holding on to only until the sidecar catches up with
  // it — at which point the server's list has stopped being the newer of the
  // two and would only go stale in the list.
  //
  // Watched by VALUE, not by the computed's identity: the sidecar is re-read on
  // every mirrored change, and most of those carry no flag at all (a checkpoint
  // writing contributor records is the common one). Firing on those would drop
  // the refusal in the window it exists for — before the flags it named have
  // been mirrored back — and the surface would open on nothing.
  watch(() => JSON.stringify(sidecarBlocks.value), () => {
    if (publishBlockers.value.length > 0) publishBlockers.value = []
  })

  /**
   * What the BUTTON says — the derivation alone, deliberately not the union.
   *
   * Disabling on a past refusal would let one stale answer strand the page: a
   * blocker approved out of band clears in Drupal and in the sidecar, but
   * nothing would re-open a button that a refusal had latched shut. Following
   * the derivation means the control can only ever be held by a block Drupal
   * named and the sidecar still shows waiting. A racing click before the mirror
   * lands is answered, never obeyed — the gate checkpoints and refuses again.
   */
  const awaitingCount = computed(() => Object.keys(sidecarBlocks.value).length)

  /**
   * The queue as navigable rows. Recomputed from the sidecar and when the
   * surface opens — a ProseMirror document is not part of Vue's reactive graph,
   * so the excerpt and position of each row are read at the moments they can
   * matter rather than tracked per keystroke.
   */
  const reviewRows = ref<ReviewQueueRow[]>([])
  /**
   * Blocks with no id: no review lane, so Drupal refuses the publish
   * structurally. Counted off the same document as the queue, so the surface
   * names both holds before the refusal does.
   */
  const unidentifiedCount = ref(0)
  watch([awaitingBlocks, reviewOpen], () => {
    const doc = editorInstance.value?.state.doc
    const sidecar = session.value?.blockMeta.value ?? {}
    // No session yet means no editor either, so the queue below is empty and
    // this stands in for nobody rather than deciding anything.
    const reviewer = session.value?.reviewer.value ?? { uid: null, isAdmin: false }
    reviewRows.value = doc ? reviewQueue(doc, awaitingBlocks.value, sidecar, reviewer) : []
    unidentifiedCount.value = doc ? unidentifiedBlocks(doc).length : 0
  }, { immediate: true })

  /**
   * How many of the waiting blocks this reader can clear themselves — the
   * number fago asked to see. The rest are somebody else's move, and saying so
   * is the difference between a queue and a nag.
   */
  const reviewableNow = computed(() => reviewableCount(reviewRows.value))

  /** A row standing for an item the document holds no block for sends nobody
   *  anywhere: it is signed off from the row itself. */
  function goToReviewBlock(row: ReviewQueueRow) {
    if (row.pos !== null) session.value?.goToBlock(row.pos)
  }

  /**
   * The threads as the surface lists them. Recomputed on the same beats as the
   * review rows and for the same reason: each row carries the text of the block
   * it is on, and a ProseMirror document is not part of Vue's reactive graph.
   *
   * The editor is watched as "is it there", never by value: threads mirrored
   * before it mounts would otherwise stay unlisted, and deep-watching a TipTap
   * instance would walk the whole editor on every change.
   */
  const commentThreads = ref<CommentThreadView[]>([])
  watch([() => session.value?.threads.value, () => !!editorInstance.value, reviewOpen], () => {
    const doc = editorInstance.value?.state.doc
    commentThreads.value = doc ? commentRows(doc, session.value?.threads.value ?? []) : []
  }, { immediate: true, deep: true })

  /**
   * Open threads this reader is expected to act on — their own and their
   * agents'. Counted off that same list, so the badge and the filter can never
   * disagree about what is there.
   */
  const assigned = computed(() =>
    assignedCounts(commentThreads.value, session.value?.me.value ?? null))

  // Pressing a margin badge opens the review surface on that block's
  // conversation.
  watch(() => session.value?.threadsShownFor.value, (shown) => {
    if (shown) reviewOpen.value = true
  })

  // The composer lives in the review surface, so starting a comment opens it —
  // otherwise the toolbar action appears to do nothing at all.
  watch(() => session.value?.commentDraft.value, (draft) => {
    if (draft) reviewOpen.value = true
  })

  /**
   * Publishing makes the working copy the live revision, so the read view under
   * the editor is stale afterwards; publishing from the editor ends on the
   * published page. `exitToRead` is the same exit Save and Close take, so the
   * refetch, the transition and the dropped `?edit` are identical however the
   * session ends. A refusal opens the surface on the blocks the gate is holding.
   */
  async function publishPage() {
    if (await publish()) {
      if (mode.value === 'edit') await exitToRead()
      else await refreshPage()
      return
    }
    if (publishBlockers.value.length > 0) reviewOpen.value = true
  }

  return {
    reviewOpen,
    reviewParked,
    awaitingCount,
    unidentifiedCount,
    reviewRows,
    reviewableNow,
    commentThreads,
    assigned,
    goToReviewBlock,
    goToCommentBlock,
    publishPage,
  }
}
