<script setup lang="ts">
import { computed } from 'vue'
import { itemName, reviewableCount, STEP_LABEL, type ReviewQueueRow, type WaitingState } from '../review-marks'
import type { CommentThreadView, ShownThreads } from '../comment-marks'
import type { AssigneeCandidate } from '../comment-assignee'
import type { CommentAnchor, CommentAssignee } from '#shared/block-comments'
import { REVIEW_STEPS, type ReviewStep } from '#shared/page-blocks'

/**
 * The one review surface beside the editor: what holds this page back from
 * publishing, and the notes on those same blocks — one list, since clearing
 * review debt and answering notes are one pass. Frameless: the page's side
 * pane renders it from `lg`, the slideover below that.
 */
const props = defineProps<{
  /** The blocks still owing a review, in document order. */
  queue: ReviewQueueRow[]
  /** The steps this space enforces — what the queue was filtered by. */
  steps: readonly ReviewStep[]
  /** Every comment thread on this document, oldest first. */
  threads: CommentThreadView[]
  /** The thread being composed, before it has anything to say. */
  commentDraft: { blockId: string, anchor: CommentAnchor | null } | null
  /** The last press on a margin badge — the conversation to scroll to. */
  threadsShownFor: ShownThreads | null
  /** Who a comment can be handed to, in the order the picker offers them. */
  assigneeCandidates: AssigneeCandidate[]
  /** This session's own identity — what "assigned to you" is measured against. */
  me: CommentAssignee | null
  /** How many blocks carry no id — the hold no sign-off can clear. */
  unidentified: number
}>()

const emit = defineEmits<{
  'jump': [ReviewQueueRow]
  'approve': [{ item: string, step: ReviewStep }]
  'jump-block': [string]
  'post-comment': [{ text: string, assignee: CommentAssignee | null }]
  'discard-comment': []
  'reply-comment': [{ blockId: string, threadId: string, text: string }]
  'resolve-comment': [{ blockId: string, threadId: string, resolved: boolean }]
  'assign-comment': [{ blockId: string, threadId: string, assignee: CommentAssignee | null }]
}>()

/**
 * The queue grouped under the step each block is waiting for. A block owing
 * both appears under both: they are answered by different people doing
 * different things, and one row would hide the second job behind the first.
 */
const groups = computed(() => REVIEW_STEPS
  .filter(step => props.steps.includes(step))
  .map(step => ({ step, rows: props.queue.filter(row => row.steps.includes(step)) }))
  .filter(group => group.rows.length > 0))

/**
 * How many of the listed blocks this reader can clear themselves — the only
 * number in the queue that names an action. The rest is waiting on other
 * people, and an editor who cannot tell the two apart finds out by refusal.
 */
const reviewable = computed(() => reviewableCount(props.queue))

/** What a row says about whose move it is — never colour alone. */
const ROW_STATE: Record<WaitingState, string> = {
  'reviewable': 'Yours to sign off',
  'awaiting-others': 'Needs somebody else',
  'unattributed': 'Needs an admin',
}

/** A block reads as its first words — enough to recognise, short enough to scan. */
function excerpt(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return 'Empty block'
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed
}

/**
 * How a row reads. A removed block and the title have no text in the document,
 * so they are named rather than quoted; a moved block reads the same as it did
 * and is told apart by what its row says (ADR 0017).
 */
function rowLabel(row: ReviewQueueRow): string {
  if (row.kind === 'block') return excerpt(row.text)
  if (row.kind === 'moved') return `${excerpt(row.text)} — moved`
  return row.kind === 'field' ? itemName(row.id) : `${itemName(row.id)} — removed`
}

/** The sign-off a row offers on one step, or undefined where it draws none. */
function approvalOn(row: ReviewQueueRow, step: ReviewStep) {
  return row.approvals.find(approval => approval.step === step)
}
</script>

<template>
  <div data-testid="review-panel">
    <!-- Shown up front: an id-less block has no review lane, so no sign-off
         clears it. Typing in it mints the id. -->
    <p
      v-if="unidentified > 0"
      class="mb-4 text-sm text-warning"
      data-testid="review-unidentified"
    >
      {{ unidentified === 1 ? 'One block has no id' : `${unidentified} blocks have no id` }}
      and cannot be reviewed, so the page cannot publish. Editing such a block gives it one.
    </p>

    <!-- "Nothing is waiting", not "everything is signed off": a block nobody
         has changed carries no sign-off either, and it is on the page all the
         same. Saying otherwise would credit a review nobody gave. -->
    <p
      v-if="groups.length === 0 && unidentified === 0"
      class="text-sm text-muted"
      data-testid="review-queue-empty"
    >
      Nothing is waiting for review.
    </p>

    <template v-else-if="groups.length > 0">
      <p class="text-sm text-muted" data-testid="review-queue-summary">
        {{ queue.length === 1 ? 'One change is' : `${queue.length} changes are` }}
        waiting for review. The page publishes once they are all signed off.
      </p>
      <!-- The line that answers "what can I do about it": the four-eyes rule
           means most of a queue is usually somebody else's move. -->
      <p class="mb-4 text-sm text-highlighted" data-testid="review-queue-reviewable">
        {{ reviewable === 0
          ? 'None of them is yours to sign off.'
          : `You can sign off ${reviewable} of them.` }}
      </p>

      <section
        v-for="group in groups"
        :key="group.step"
        class="mb-4"
        :aria-labelledby="`okb-review-step-${group.step}`"
      >
        <h3
          :id="`okb-review-step-${group.step}`"
          class="mb-1 flex items-center gap-2 text-sm font-medium text-highlighted"
        >
          <UIcon
            :name="group.step === 'agent' ? 'i-lucide-sparkles' : 'i-lucide-users'"
            :class="group.step === 'agent' ? 'text-(--okb-agent-text)' : 'text-muted'"
            class="size-4"
            aria-hidden="true"
          />
          {{ STEP_LABEL[group.step] }} ({{ group.rows.length }})
        </h3>
        <ul class="flex flex-col gap-1">
          <li v-for="row in group.rows" :key="row.id" class="flex items-center gap-1">
            <UButton
              block
              color="neutral"
              variant="ghost"
              size="sm"
              class="min-w-0 justify-start text-left"
              :disabled="row.pos === null"
              :data-testid="`review-queue-${row.id}`"
              @click="emit('jump', row)"
            >
              <span class="truncate">
                <span
                  class="mr-1"
                  :class="row.state === 'reviewable' ? 'text-warning' : 'text-muted'"
                  aria-hidden="true"
                >{{ row.state === 'reviewable' ? '●' : '○' }}</span>
                {{ rowLabel(row) }}
              </span>
              <span
                class="ml-auto shrink-0 text-xs"
                :class="row.state === 'reviewable' ? 'text-highlighted' : 'text-muted'"
                :data-testid="`review-queue-state-${row.id}`"
              >{{ ROW_STATE[row.state] }}</span>
            </UButton>
            <!-- A row with no block in the document has no margin pill to be
                 signed off from, so the sign-off is here. `aria-disabled`, not
                 `disabled`: a refused control keeps its tooltip and its place
                 in the tab order. -->
            <UButton
              v-if="row.pos === null && approvalOn(row, group.step)"
              icon="i-lucide-check"
              color="neutral"
              variant="ghost"
              size="sm"
              class="shrink-0"
              :aria-label="approvalOn(row, group.step)!.label"
              :aria-disabled="!!approvalOn(row, group.step)!.refusal"
              :title="approvalOn(row, group.step)!.refusal ?? undefined"
              :data-testid="`review-queue-approve-${row.id}`"
              @click="approvalOn(row, group.step)!.refusal || emit('approve', { item: row.id, step: group.step })"
            />
          </li>
        </ul>
      </section>
    </template>

    <hr class="my-4 border-default">

    <EditorCommentThreads
      :threads="threads"
      :draft="commentDraft"
      :shown-for="threadsShownFor"
      :candidates="assigneeCandidates"
      :me="me"
      @post="emit('post-comment', $event)"
      @discard="emit('discard-comment')"
      @reply="emit('reply-comment', $event)"
      @resolve="emit('resolve-comment', $event)"
      @assign="emit('assign-comment', $event)"
      @jump="emit('jump-block', $event)"
    />
  </div>
</template>
