<script setup lang="ts">
import type { EditorSession } from '~/components/PageInlineEditor.vue'
import type { ModerationStatus } from '#shared/utils/moderation'
import type { ReviewStep } from '#shared/page-blocks'
import { isAuthFailedStatus } from '~/composables/useLiveCollab'
import type { AssignedCounts } from '~/editor/comment-assignee'
import { reviewToggleLabel } from '~/editor/review-marks'

const props = defineProps<{
  session: EditorSession
  status: ModerationStatus | null
  busy: 'publish' | 'revert' | null
  awaitingCount: number
  /** Blocks carrying no id — a hold no sign-off clears (OKB-121). */
  unidentifiedCount: number
  /** How many of those this reader can sign off themselves. */
  reviewableNow: number
  /** Open comment threads waiting on this reader — their own and their agents'. */
  assigned: AssignedCounts
  /** The review steps this space enforces — empty where it runs none. */
  reviewSteps: readonly ReviewStep[]
  nid?: number
  canMove: boolean
  canDelete: boolean
  title: string
  /** The page's revisions page, when this session may follow it. */
  historyHref?: string | null
  /** The page's raw-markdown endpoint (View as Markdown). */
  markdownHref?: string
}>()

const emit = defineEmits<{
  (e: 'publish'): void
  (e: 'save'): void
  (e: 'close'): void
  (e: 'deleted'): void
}>()

const reviewOpen = defineModel<boolean>('reviewOpen', { default: false })

const saveDisabled = computed(() =>
  props.session.commitStatus.value === 'saving'
  || isAuthFailedStatus(props.session.liveStatus.value))

const dirty = computed(() => props.session.commitStatus.value === 'dirty')

const reviewLabel = computed(() => reviewToggleLabel({
  unidentified: props.unidentifiedCount,
  awaiting: props.awaitingCount,
  reviewableNow: props.reviewableNow,
  assigned: props.assigned,
}))
</script>

<template>
  <!-- The one state indicator: live-session health, or the commit lane. -->
  <NodeSyncChip :session="session" />

  <!-- The way into the review queue. Always on offer where a step is
       enforced: "nothing is waiting" is an answer an editor wants before
       pressing Publish. An id-less block holds the page in every space, so it
       opens the way in by itself. -->
  <UButton
    v-if="reviewSteps.length > 0 || assigned.total > 0 || unidentifiedCount > 0"
    color="neutral"
    variant="soft"
    size="sm"
    icon="i-lucide-clipboard-check"
    :aria-label="reviewLabel"
    :title="reviewLabel"
    :aria-pressed="reviewOpen"
    data-testid="review-toggle"
    @click="reviewOpen = !reviewOpen"
  >
    <span class="hidden @2xl/editnav:inline">Review</span>
    <UBadge
      v-if="awaitingCount > 0"
      color="warning"
      variant="subtle"
      size="sm"
      data-testid="review-awaiting-count"
    >
      {{ awaitingCount }}
    </UBadge>
    <!-- The page's review debt and the threads handed to this reader are
         different things to act on, so they are different numbers. A thread
         one of their agents holds is theirs to answer for, so it is in here
         too; the accessible name says how the number splits. -->
    <UBadge
      v-if="assigned.total > 0"
      color="primary"
      variant="subtle"
      size="sm"
      icon="i-lucide-message-square"
      data-testid="review-assigned-count"
    >
      {{ assigned.total }}
    </UBadge>
  </UButton>
  <EditorPresenceAvatars :peers="session.presence.value" class="hidden @2xl/editnav:flex" />

  <!-- Edit mode keeps only Publish, carrying the awaiting count. The badges and
       Revert-to-published belong to the read page. Publish is the primary act:
       Save beside it writes a revision and leaves the live page alone. -->
  <ViewModerationControls
    :status="status"
    :busy="busy"
    :pending-edits="dirty"
    :awaiting="awaitingCount"
    publish-only
    @publish="emit('publish')"
  />

  <!-- Fixed right cluster — always survives the collapse: Save · ⋯ · ✕. -->
  <UButton
    color="neutral"
    variant="soft"
    size="sm"
    icon="i-lucide-save"
    aria-label="Save to history"
    :loading="session.commitStatus.value === 'saving'"
    :disabled="saveDisabled"
    @click="emit('save')"
  >
    Save
  </UButton>
  <ViewPageMenu
    v-if="nid"
    edit
    :nid="nid"
    :title="title"
    :can-move="canMove"
    :can-delete="canDelete"
    :dirty="dirty"
    :history-href="historyHref"
    :markdown-href="markdownHref"
    @attach="session.attachFile"
    @revert="session.revert"
    @deleted="emit('deleted')"
  />
  <UButton
    color="neutral"
    variant="ghost"
    size="sm"
    icon="i-lucide-x"
    aria-label="Close editor"
    @click="emit('close')"
  />
</template>
