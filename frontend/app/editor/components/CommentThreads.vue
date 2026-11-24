<script setup lang="ts">
// Explicit, not auto-imported: the component is rendered by its own vitest
// suite outside a Nuxt app.
import { computed, onMounted, provide, ref, watch } from 'vue'
import type { CommentDraft, CommentThreadView, ShownThreads } from '../comment-marks'
import {
  addedMention,
  assignedCounts,
  draftToComark,
  filterThreads,
  insertMention,
  isSameAssignee,
  mentionName,
  readerStanding,
  type AssigneeCandidate,
  type ThreadFilter,
} from '../comment-assignee'
import EditorMentionTextarea from './MentionTextarea.vue'
import EditorCommentText from './CommentText.vue'
import type { CommentAssignee } from '#shared/block-comments'
import { handlingLive } from '#shared/utils/chat-agent'
import { ownedLabel } from '#shared/utils/attribution'
import { VIEWER_UID, withCurrentName } from '../../composables/useAccountNames'

/**
 * The comment half of the review drawer (OKB-121) — every conversation open on
 * this document, and the one being composed.
 *
 * Threads are listed rather than drawn beside the blocks they are about: the
 * editor marks the block and highlights the passage, and the drawer is where
 * the conversation is read and answered. One surface for both means an editor
 * clearing a page's review debt never has to decide which panel to open.
 *
 * Resolved threads are kept, behind a disclosure. A resolved conversation is
 * the record of a decision about the text, and the reasoning is the part worth
 * keeping — but it is not what the drawer is for once it is settled.
 *
 * A thread can be handed to somebody: the assignee menu of the composer or of
 * a reply, a typed `@` mention, or the chip on a thread's header. The hand-over
 * is the thread's, never one message's — a conversation has one owner at a
 * time. Only a person marks one done: an agent answers and leaves the standing
 * to whoever asked.
 */
const props = defineProps<{
  threads: CommentThreadView[]
  /** The thread being composed, before it has anything to say. */
  draft: CommentDraft | null
  /** The last press on a margin badge — the conversation to bring into view. */
  shownFor?: ShownThreads | null
  /** Who a thread can be handed to, in the order the picker offers them. */
  candidates: AssigneeCandidate[]
  /** This session's own identity — what "assigned to you" is measured against. */
  me: CommentAssignee | null
  /** Who a new thread starts assigned to; null or absent for nobody. */
  defaultAssignee?: CommentAssignee | null
}>()

const emit = defineEmits<{
  post: [{ text: string, assignee: CommentAssignee | null }]
  discard: []
  reply: [{ blockId: string, threadId: string, text: string }]
  resolve: [{ blockId: string, threadId: string, resolved: boolean }]
  assign: [{ blockId: string, threadId: string, assignee: CommentAssignee | null }]
  jump: [string]
}>()

/** What the list says when the filter it is on holds nothing. */
const EMPTY: Record<ThreadFilter, string> = {
  mine: 'Nothing is assigned to you.',
  agents: 'Nothing is assigned to your agents.',
  all: 'No open comments.',
}

/** What the list shows; the whole conversation by default. */
const filter = ref<ThreadFilter>('all')

provide(VIEWER_UID, computed(() => props.me?.uid))

const counts = computed(() => assignedCounts(props.threads, props.me))
/** Whether this reader has an agent at all — the agents tab is theirs alone. */
const hasAgents = computed(() =>
  props.candidates.some(candidate => candidate.via && candidate.uid === props.me?.uid))
const filterItems = computed(() => [
  { value: 'mine', label: 'Assigned to me', ...(counts.value.mine ? { badge: counts.value.mine } : {}) },
  ...(hasAgents.value
    ? [{
        value: 'agents',
        label: 'Assigned to my agents',
        ...(counts.value.myAgents ? { badge: counts.value.myAgents } : {}),
      }]
    : []),
  { value: 'all', label: 'All' },
])

// The agents tab goes when the reader's last agent does, so the list may not be
// left on a filter that is no longer offered.
watch(hasAgents, (has) => { if (!has && filter.value === 'agents') filter.value = 'all' })

const shown = computed(() => filterThreads(props.threads, filter.value, props.me))
const open = computed(() => shown.value.filter(t => !t.resolved))
const resolved = computed(() => shown.value.filter(t => t.resolved))

const draftText = ref('')
/** Who the open draft goes to: set when the draft opens, then only by the reader. */
const draftAssignee = ref<CommentAssignee | null>(props.defaultAssignee ?? null)
/** The thread the reply box is open on — one at a time, like a focused field. */
const replyingTo = ref<string | null>(null)
const replyText = ref('')
/** Who the open reply hands the thread to; undefined while the reader chose nothing. */
const replyAssignee = ref<CommentAssignee | null | undefined>()
// What each picker is placed against: the whole composer, not the button in it.
const draftBox = ref<HTMLElement | null>(null)
const replyBoxes = ref<HTMLElement | HTMLElement[] | null>(null)
/** A `ref` inside `v-for` collects an array; one reply box is open at a time. */
const replyBox = computed<HTMLElement | null>(() =>
  (Array.isArray(replyBoxes.value) ? replyBoxes.value[0] : replyBoxes.value) ?? null)

// A fresh draft gets a fresh box: the previous one was either posted or
// discarded, and carrying its text into a comment about different words is
// how a note ends up on the wrong passage.
watch(() => props.draft, () => {
  draftText.value = ''
  draftAssignee.value = props.defaultAssignee ?? null
})

/**
 * Brings a comment into view when the editor selects one: the comment whose
 * highlighted passage was clicked, else the block its margin badge sits on.
 * The filter is cleared first, so a comment it would hide is still shown.
 */
const list = ref<HTMLElement | null>(null)
/** The comment the editor selected, so the list can outline it. */
const selectedThreadId = ref<string | null>(null)
/** The selector of the comment or block still to be brought into view. */
const pendingScrollTarget = ref<string | null>(null)
watch(() => props.shownFor, (shown) => {
  if (!shown) return
  filter.value = 'all'
  selectedThreadId.value = shown.threadId ?? null
  pendingScrollTarget.value = shown.threadId
    ? `[data-comment-thread="${CSS.escape(shown.threadId)}"]`
    : `[data-comment-block="${CSS.escape(shown.blockId)}"]`
}, {
  // The drawer unmounts this list while closed, so a click with it closed
  // must apply on mount.
  immediate: true,
})
// The threads can arrive after the click that selected one of them.
watch([pendingScrollTarget, shown], scrollPendingTargetIntoView, { flush: 'post' })
onMounted(scrollPendingTargetIntoView)

/** Scrolls the selected comment or block into view once the list shows it. */
function scrollPendingTargetIntoView(): void {
  const target = pendingScrollTarget.value ? list.value?.querySelector(pendingScrollTarget.value) : null
  if (!target) return
  pendingScrollTarget.value = null
  // Centred, not nearest: a comment parked at the edge is easy to miss.
  target.scrollIntoView({ block: 'center' })
}

// --- the composer's assignee -----------------------------------------------

const mentionOpen = ref(false)
/** Where the `@` being completed sits in the draft; null when none is. */
const mentionAt = ref<number | null>(null)
const replyMentionOpen = ref(false)
const replyMentionAt = ref<number | null>(null)

// A typed `@` is completed only while its palette is open.
watch(mentionOpen, (open) => { if (!open) mentionAt.value = null })
watch(replyMentionOpen, (open) => { if (!open) replyMentionAt.value = null })

/** Who an edit of a draft or reply newly mentions; null when it adds no mention. */
function addedMentionAssignee(before: string, after: string): CommentAssignee | null {
  const who = addedMention(before, after, props.candidates, props.me?.uid)
  return who ? plainAssignee(who) : null
}

// A mention selects its assignee as the reader writes it. Only a text edit
// selects: deleting a mention, or a new presence list, keeps the selection.
// A reply's mention hands the thread over, not the message.
watch(draftText, (after, before) => {
  const who = addedMentionAssignee(before, after)
  if (who) draftAssignee.value = who
})
watch(replyText, (after, before) => {
  const who = addedMentionAssignee(before, after)
  if (who) replyAssignee.value = who
})

/** The assignee without the picker's own fields, as a thread stores it. */
function plainAssignee(who: CommentAssignee): CommentAssignee {
  return { uid: who.uid, name: who.name, via: who.via ?? null }
}

/** How the assignee button names a choice. */
function assigneeLabel(who: CommentAssignee | null): string {
  return who ? ownedLabel(who, props.me?.uid) : 'Nobody'
}

/** Who the reply form shows: the reader's choice, else the thread's assignee. */
function replyAssigneeShown(thread: CommentThreadView): CommentAssignee | null {
  return replyAssignee.value === undefined ? thread.assignee ?? null : replyAssignee.value
}

/**
 * Opens the picker on a typed `@`, which a pick then completes to a mention.
 * Read off the input rather than the keystroke, so the character has landed in
 * the draft before the palette takes the focus.
 */
function onDraftInput(event: Event): void {
  if ((event as InputEvent).data !== '@') return
  const field = event.target as HTMLTextAreaElement
  mentionAt.value = (field.selectionStart ?? 1) - 1
  mentionOpen.value = true
}

/** Opens the reply's picker on a typed `@`, as {@link onDraftInput} does. */
function onReplyInput(event: Event): void {
  if ((event as InputEvent).data !== '@') return
  const field = event.target as HTMLTextAreaElement
  replyMentionAt.value = (field.selectionStart ?? 1) - 1
  replyMentionOpen.value = true
}

/** The text with the `@` typed at `at` completed to a mention of `who`. */
function completeTypedMention(text: string, at: number, who: CommentAssignee): string {
  return insertMention(text, at, mentionName(who, props.me?.uid))
}

/** Selects the draft's assignee; a pick that completes a typed `@` writes the mention too. */
function pickDraftAssignee(who: CommentAssignee | null): void {
  if (who && mentionAt.value !== null) {
    draftText.value = completeTypedMention(draftText.value, mentionAt.value, who)
  }
  draftAssignee.value = who
}

/** Selects who the reply hands the thread to, as {@link pickDraftAssignee} does. */
function pickReplyAssignee(who: CommentAssignee | null): void {
  if (who && replyMentionAt.value !== null) {
    replyText.value = completeTypedMention(replyText.value, replyMentionAt.value, who)
  }
  replyAssignee.value = who
}

/**
 * Ctrl+Enter (Cmd+Enter) posts what the textarea holds; Enter alone stays a
 * newline, since a comment is often more than one line.
 */
function submitOn(event: KeyboardEvent, submit: () => void): void {
  if (!(event.ctrlKey || event.metaKey)) return
  event.preventDefault()
  submit()
}

/** The draft as stored text: its mentions name their account by uid. */
function storedText(draft: string): Promise<string> {
  return draftToComark(draft, props.candidates, props.me?.uid)
}

/** Posts the draft as a new thread, assigned to the form's choice. */
async function post() {
  const draft = draftText.value
  if (!draft.trim()) return
  const to = draftAssignee.value
  draftText.value = ''
  emit('post', { text: await storedText(draft), assignee: to ? plainAssignee(to) : null })
}

// --- threads ---------------------------------------------------------------

/** Posts the reply, handing the thread on when the reader chose another assignee. */
async function reply(thread: CommentThreadView) {
  const draft = replyText.value
  if (!draft.trim()) return
  const to = replyAssignee.value
  if (to !== undefined) {
    assign(thread, to ? plainAssignee(to) : null)
  }
  replyText.value = ''
  replyingTo.value = null
  emit('reply', { blockId: thread.blockId, threadId: thread.threadId, text: await storedText(draft) })
}

/** Opens the reply box on a thread, or closes the one open on it. */
function startReply(threadId: string) {
  replyingTo.value = replyingTo.value === threadId ? null : threadId
  replyText.value = ''
  replyAssignee.value = undefined
  replyMentionOpen.value = false
}

/** Hands the thread to `who`, or to nobody; the thread's own assignee writes nothing. */
function assign(thread: CommentThreadView, who: CommentAssignee | null) {
  if (isSameAssignee(who, thread.assignee)) {
    return
  }
  emit('assign', { blockId: thread.blockId, threadId: thread.threadId, assignee: who })
}

/** Whether this reader is the one expected to act on the thread. */
function isMine(thread: CommentThreadView): boolean {
  return readerStanding(thread.assignee, props.me) === 'me'
}

/** How a thread handed to one of this reader's own agents reads to them. */
function myAgentLine(thread: CommentThreadView): string | null {
  return readerStanding(thread.assignee, props.me) === 'my-agent'
    ? `Assigned to your agent ${thread.assignee!.via}`
    : null
}

/** Whether a chat tab is working the thread now; a release re-renders the list. */
function beingHandled(thread: CommentThreadView): boolean {
  return handlingLive(thread.handling, Date.now())
}

/** The thread's assignment as a line of its log. */
function assignLine(thread: CommentThreadView): string {
  const by = thread.assignedBy
  if (!by) return ''
  return thread.assignee
    ? `${who(by)} assigned this to ${ownedLabel(withCurrentName(thread.assignee), props.me?.uid)}`
    : `${who(by)} unassigned this`
}

/** What a thread is about: the passage it was opened on, or its block. */
function subject(thread: CommentThreadView): string {
  return excerpt(thread.anchor?.quote || thread.blockText || 'Empty block')
}

function excerpt(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return 'Empty block'
  return trimmed.length > 60 ? `${trimmed.slice(0, 59)}…` : trimmed
}

/** Who said it, named as the presence strip names them. */
function who(message: { uid?: number | null, name?: string | null, via?: string | null }): string {
  const named = withCurrentName(message)
  return ownedLabel({ ...named, name: named.name || 'Someone' }, props.me?.uid)
}

function when(at: number): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
}
</script>

<template>
  <section aria-labelledby="okb-review-comments">
    <div class="mb-2 flex flex-wrap items-center gap-2">
      <h3 id="okb-review-comments" class="text-xs font-semibold uppercase tracking-wide text-muted">
        Comments
      </h3>
      <UTabs
        v-model="filter"
        :items="filterItems"
        :content="false"
        size="xs"
        color="neutral"
        variant="link"
        aria-label="Filter comments"
        class="ml-auto"
        data-testid="comment-filter"
      />
    </div>

    <!-- The composer sits above the list: it is about the passage the editor
         just selected, and burying it under existing threads would ask them to
         scroll away from what they were looking at. -->
    <div v-if="draft" ref="draftBox" class="mb-4 rounded-md border border-accented p-2" data-testid="comment-draft">
      <p class="mb-2 truncate text-xs text-muted">
        On “{{ excerpt(draft.anchor?.quote || draft.label) }}”
      </p>
      <EditorMentionTextarea
        v-model="draftText"
        :candidates="candidates"
        :viewer-uid="me?.uid ?? null"
        :rows="3"
        autofocus
        placeholder="Leave a note for the other editors — @ to mention somebody…"
        aria-label="Comment"
        @input="onDraftInput"
        @keydown.enter="submitOn($event, post)"
      />
      <div class="mt-2 flex flex-wrap items-center gap-2">
        <EditorAssigneePicker
          v-model:open="mentionOpen"
          :candidates="candidates"
          :viewer-uid="me?.uid ?? null"
          :anchor="draftBox"
          :selected="draftAssignee"
          @pick="pickDraftAssignee"
        >
          <UButton
            icon="i-lucide-at-sign"
            color="neutral"
            variant="ghost"
            size="xs"
            class="max-w-48"
            :aria-label="`Assignee: ${assigneeLabel(draftAssignee)}`"
            data-testid="comment-assignee"
          >
            {{ assigneeLabel(draftAssignee) }}
          </UButton>
        </EditorAssigneePicker>
        <UButton class="ml-auto" color="neutral" variant="ghost" size="sm" @click="emit('discard')">
          Cancel
        </UButton>
        <UButton
          color="primary"
          size="sm"
          :disabled="!draftText.trim()"
          data-testid="comment-post"
          @click="post"
        >
          Comment
        </UButton>
      </div>
    </div>

    <p v-if="open.length === 0 && !draft" class="text-sm text-muted" data-testid="comments-empty">
      {{ EMPTY[filter] }}
    </p>

    <ul ref="list" class="flex flex-col gap-3">
      <li
        v-for="thread in open"
        :key="thread.threadId"
        class="rounded-md border p-2"
        :class="selectedThreadId === thread.threadId ? 'border-primary ring-1 ring-primary' : 'border-default'"
        :data-testid="`comment-thread-${thread.threadId}`"
        :data-comment-thread="thread.threadId"
        :data-comment-block="thread.blockId"
      >
        <div class="mb-2 flex items-start gap-1">
          <UButton
            color="neutral"
            variant="link"
            size="xs"
            class="group min-w-0 flex-1 cursor-pointer justify-start p-0 text-left"
            :aria-label="`Go to the block commented on: ${subject(thread)}`"
            @click="emit('jump', thread.blockId)"
          >
            <span class="truncate text-xs italic text-muted underline-offset-2 group-hover:underline group-hover:text-primary">“{{ subject(thread) }}”</span>
          </UButton>
          <EditorAssigneePicker
            v-if="!thread.assignee"
            :candidates="candidates"
            :viewer-uid="me?.uid ?? null"
            @pick="assign(thread, $event)"
          >
            <UButton
              icon="i-lucide-user-plus"
              color="neutral"
              variant="ghost"
              size="xs"
              aria-label="Assign this comment to somebody"
              :data-testid="`comment-assign-${thread.threadId}`"
            />
          </EditorAssigneePicker>
          <UButton
            icon="i-lucide-check"
            color="neutral"
            variant="ghost"
            size="md"
            class="text-highlighted hover:bg-success/10 hover:text-success"
            aria-label="Resolve this comment"
            :data-testid="`comment-resolve-${thread.threadId}`"
            @click="emit('resolve', { blockId: thread.blockId, threadId: thread.threadId, resolved: true })"
          />
        </div>

        <div v-if="thread.assignee" class="mb-2 flex flex-wrap items-center gap-2">
          <EditorAssigneePicker
            :candidates="candidates"
            :viewer-uid="me?.uid ?? null"
            :selected="thread.assignee"
            allow-unassign
            @pick="assign(thread, $event)"
          >
            <EditorAssigneeChip :assignee="withCurrentName(thread.assignee)" :viewer-uid="me?.uid ?? null" />
          </EditorAssigneePicker>
          <span
            v-if="myAgentLine(thread)"
            class="text-xs font-medium text-(--okb-agent-text)"
            :data-testid="`comment-assigned-to-my-agent-${thread.threadId}`"
          >{{ myAgentLine(thread) }}</span>
          <span
            v-if="beingHandled(thread)"
            role="status"
            class="inline-flex items-center gap-1 text-xs font-medium text-(--okb-agent-text)"
            :data-testid="`comment-handling-${thread.threadId}`"
          >
            <UIcon name="i-lucide-loader-circle" class="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            {{ ownedLabel(withCurrentName(thread.assignee!), me?.uid) }} is working on this
          </span>
          <template v-if="isMine(thread)">
            <span
              class="text-xs font-medium text-primary"
              :data-testid="`comment-assigned-to-me-${thread.threadId}`"
            >Assigned to you</span>
            <UButton
              color="primary"
              variant="soft"
              size="xs"
              icon="i-lucide-check-check"
              :data-testid="`comment-done-${thread.threadId}`"
              @click="emit('resolve', { blockId: thread.blockId, threadId: thread.threadId, resolved: true })"
            >
              Mark as done
            </UButton>
          </template>
        </div>

        <ol class="flex flex-col gap-2">
          <li v-for="message in thread.messages" :key="message.id" class="text-sm">
            <p class="text-xs text-muted">
              <span class="font-medium text-highlighted">{{ who(message) }}</span>
              <time class="ml-1">{{ when(message.at) }}</time>
            </p>
            <EditorCommentText
              class="whitespace-pre-wrap text-toned"
              :text="message.text ?? ''"
              :data-testid="`comment-message-${message.id}`"
            />
          </li>
        </ol>

        <p
          v-if="thread.assignedBy"
          class="mt-2 text-xs italic text-muted"
          :data-testid="`comment-assign-log-${thread.threadId}`"
        >
          {{ assignLine(thread) }}
        </p>

        <div v-if="replyingTo === thread.threadId" ref="replyBoxes" class="mt-2">
          <EditorMentionTextarea
            v-model="replyText"
            :candidates="candidates"
            :viewer-uid="me?.uid ?? null"
            :rows="2"
            autofocus
            placeholder="Reply — @ to hand the thread on…"
            :aria-label="`Reply to the comment on ${subject(thread)}`"
            @input="onReplyInput"
            @keydown.enter="submitOn($event, () => reply(thread))"
          />
          <div class="mt-1 flex flex-wrap items-center gap-2">
            <EditorAssigneePicker
              v-model:open="replyMentionOpen"
              :candidates="candidates"
              :viewer-uid="me?.uid ?? null"
              :anchor="replyBox"
              :selected="replyAssigneeShown(thread)"
              :assigned="thread.assignee ?? null"
              @pick="pickReplyAssignee"
            >
              <UButton
                icon="i-lucide-at-sign"
                color="neutral"
                variant="ghost"
                size="xs"
                class="max-w-48"
                :aria-label="`Assignee: ${assigneeLabel(replyAssigneeShown(thread))}`"
                :data-testid="`comment-reply-assignee-${thread.threadId}`"
              >
                {{ assigneeLabel(replyAssigneeShown(thread)) }}
              </UButton>
            </EditorAssigneePicker>
            <UButton
              class="ml-auto"
              color="primary"
              size="xs"
              :disabled="!replyText.trim()"
              :data-testid="`comment-reply-post-${thread.threadId}`"
              @click="reply(thread)"
            >
              Reply
            </UButton>
          </div>
        </div>
        <UButton
          v-else
          color="neutral"
          variant="ghost"
          size="xs"
          class="mt-1"
          :data-testid="`comment-reply-${thread.threadId}`"
          @click="startReply(thread.threadId)"
        >
          Reply
        </UButton>
      </li>
    </ul>

    <details v-if="resolved.length" class="mt-4">
      <summary class="cursor-pointer text-xs text-muted" data-testid="comments-resolved-toggle">
        Resolved ({{ resolved.length }})
      </summary>
      <ul class="mt-2 flex flex-col gap-2">
        <li
          v-for="thread in resolved"
          :key="thread.threadId"
          class="rounded-md border border-default p-2 text-sm"
          :data-testid="`comment-thread-${thread.threadId}`"
        >
          <p class="truncate text-xs italic text-muted">
            “{{ subject(thread) }}”
          </p>
          <EditorCommentText class="whitespace-pre-wrap text-toned" :text="thread.messages[thread.messages.length - 1]?.text ?? ''" />
          <div v-if="thread.assignee" class="mt-2">
            <EditorAssigneeChip :assignee="withCurrentName(thread.assignee)" :viewer-uid="me?.uid ?? null" />
          </div>
          <p
            v-if="thread.assignedBy"
            class="mt-2 text-xs italic text-muted"
            :data-testid="`comment-assign-log-${thread.threadId}`"
          >
            {{ assignLine(thread) }}
          </p>
          <UButton
            color="neutral"
            variant="ghost"
            size="xs"
            class="mt-1"
            :data-testid="`comment-reopen-${thread.threadId}`"
            @click="emit('resolve', { blockId: thread.blockId, threadId: thread.threadId, resolved: false })"
          >
            Reopen
          </UButton>
        </li>
      </ul>
    </details>
  </section>
</template>
