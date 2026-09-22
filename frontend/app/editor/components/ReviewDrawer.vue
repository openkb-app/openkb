<script setup lang="ts">
import { useMediaQuery } from '@vueuse/core'
import type { ReviewQueueRow } from '../review-marks'
import type { CommentThreadView, ShownThreads } from '../comment-marks'
import type { AssigneeCandidate } from '../comment-assignee'
import type { CommentAnchor, CommentAssignee } from '#shared/block-comments'
import type { ReviewStep } from '#shared/page-blocks'

/**
 * The frame the review surface gets below `lg`, where there is no side pane.
 * On a phone the sheet is the screen, so jumping to a block has to close it;
 * from `md` up it sits beside the page, non-modal, and stays open.
 */
const props = defineProps<{
  open: boolean
  queue: ReviewQueueRow[]
  steps: readonly ReviewStep[]
  threads: CommentThreadView[]
  commentDraft: { blockId: string, anchor: CommentAnchor | null } | null
  threadsShownFor: ShownThreads | null
  assigneeCandidates: AssigneeCandidate[]
  me: CommentAssignee | null
  unidentified: number
}>()

const emit = defineEmits<{
  'update:open': [boolean]
  'jump': [ReviewQueueRow]
  'approve': [{ item: string, step: ReviewStep }]
  'jump-block': [string]
  'post-comment': [{ text: string, assignee: CommentAssignee | null }]
  'discard-comment': []
  'reply-comment': [{ blockId: string, threadId: string, text: string }]
  'resolve-comment': [{ blockId: string, threadId: string, resolved: boolean }]
  'assign-comment': [{ blockId: string, threadId: string, assignee: CommentAssignee | null }]
}>()

/** From `md` the sheet is a side panel, not the screen — no overlay, no trap. */
const isDesktop = useMediaQuery('(min-width: 768px)')

const open = computed({
  get: () => props.open,
  set: value => emit('update:open', value),
})

/** A block the sheet covers is only reachable once the sheet is gone. A row
 *  with no block in the document sends nobody anywhere, so the sheet stays. */
function jump(row: ReviewQueueRow) {
  emit('jump', row)
  if (!isDesktop.value && row.pos !== null) open.value = false
}

function jumpToBlock(blockId: string) {
  emit('jump-block', blockId)
  if (!isDesktop.value) open.value = false
}
</script>

<template>
  <USlideover
    v-model:open="open"
    side="right"
    title="Review"
    description="Where this page stands, and what has been said about it"
    :modal="!isDesktop"
    :overlay="!isDesktop"
    :ui="{ content: 'w-full sm:w-[420px] sm:max-w-[92vw]' }"
  >
    <template #body>
      <EditorReviewPanel
        :queue="queue"
        :steps="steps"
        :threads="threads"
        :comment-draft="commentDraft"
        :threads-shown-for="threadsShownFor"
        :assignee-candidates="assigneeCandidates"
        :me="me"
        :unidentified="unidentified"
        @jump="jump"
        @approve="emit('approve', $event)"
        @jump-block="jumpToBlock"
        @post-comment="emit('post-comment', $event)"
        @discard-comment="emit('discard-comment')"
        @reply-comment="emit('reply-comment', $event)"
        @resolve-comment="emit('resolve-comment', $event)"
        @assign-comment="emit('assign-comment', $event)"
      />
    </template>
  </USlideover>
</template>
