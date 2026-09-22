<script setup lang="ts">
// Explicit, not auto-imported: the component is rendered by its own vitest
// suite outside a Nuxt app.
import { computed, ref } from 'vue'
import type { Grounding } from '~/utils/chat-answer'
import { UNGROUNDED_EXPLANATION, UNGROUNDED_LABEL } from '~/utils/chat-answer'

const props = defineProps<{
  /** How the answer stands, or null when nothing grounded it. */
  grounding: Grounding | null
  /** How many sources the answer cited. */
  cited: number
  /** What was asked, quoted back — capped — so the reader sees what was searched. */
  query?: string
  /** The space the turn was scoped to, when it was scoped to one. */
  scopeName?: string | null
  /** Why the turn was not answered at all, as the assistant words it. */
  error?: string | null
  /** Where to log in, when the turn was refused for want of a session. */
  loginHref?: string | null
  /**
   * Which surface renders the state.
   *
   * The chat panel shows every state. The summary leaves out the ungrounded
   * badge and the searched note; it keeps the error, the refusal and the
   * outage, which replace the answer.
   */
  surface?: 'chat' | 'summary'
}>()

const emit = defineEmits<{
  /** Ask again in other words — the surface owns the composer. */
  rephrase: []
  /** Try the same question again after an outage. */
  retry: []
}>()

// A turn that failed says so and offers the retry, and says nothing about
// grounding: there is no answer for it to stand on.
const hasError = computed(() => !!props.error)

const isUngrounded = computed(() =>
  !hasError.value && props.surface !== 'summary' && props.grounding?.state === 'ungrounded',
)
const isNoAnswer = computed(() => !hasError.value && props.grounding?.state === 'insufficient_evidence')
const isUnavailable = computed(() => !hasError.value && props.grounding?.state === 'dependency_unavailable')

// An answer standing on nothing because the search found nothing: the reader
// is owed what was searched and the same ways on as a refusal, next to the
// badge rather than instead of it.
const foundNothing = computed(() => isUngrounded.value && props.grounding?.retrieved === 0)
const waysOn = computed(() => foundNothing.value || isNoAnswer.value || isUnavailable.value)

/** Longest question quoted back in full, in characters. */
const QUERY_LIMIT = 120

// Cut on a space, so the quote ends on a word the reader recognises. A single
// word longer than the cap has none, and is cut where it runs out.
const quotedQuery = computed(() => {
  const query = (props.query ?? '').trim()
  if (query.length <= QUERY_LIMIT) return query
  const capped = query.slice(0, QUERY_LIMIT)
  const lastSpace = capped.lastIndexOf(' ')
  return `${(lastSpace > 0 ? capped.slice(0, lastSpace) : capped).trimEnd()}…`
})

// What was searched is the turn's scope, named: one space coming back empty is
// not the whole knowledge base coming back empty.
const searchedScope = computed(() =>
  props.scopeName
    ? `the pages you can read in the space “${props.scopeName}”`
    : 'the pages you can read',
)

const searched = computed(() =>
  props.query
    ? `Searched ${searchedScope.value} for “${quotedQuery.value}”.`
    : `Searched ${searchedScope.value}.`,
)

// The cap is for reading; a search runs on the whole question.
const searchHref = computed(() =>
  props.query ? `/search?q=${encodeURIComponent(props.query)}` : '/search',
)

// Bound, so a tap opens the sentence where there is no hover; the tooltip
// writes it too, on hover and on focus.
const explaining = ref(false)

/** The pane goes as narrow as `SIDE_PANE_MIN`; Nuxt UI truncates a button
 *  label there. */
const WRAPPING_LABEL = { label: 'whitespace-normal' }

/** What the block is, for a reader moving through the answer. */
const stateLabel = computed(() =>
  isUnavailable.value
    ? 'Search unavailable'
    : 'Nothing in your knowledge base answered this',
)
</script>

<template>
  <!-- The turn ended without an answer: an expected refusal is a state, not a
       blank message the reader reads as a hang. -->
  <UAlert
    v-if="hasError"
    data-test="answer-error"
    color="neutral"
    variant="subtle"
    class="mt-2"
    icon="i-lucide-triangle-alert"
    :description="error ?? ''"
    :ui="{ description: 'break-words' }"
  >
    <template #actions>
      <!-- Retrying a refused session fails the same way: the way on is the
           login page. -->
      <UButton
        v-if="loginHref"
        data-test="answer-login"
        color="neutral"
        variant="outline"
        size="xs"
        icon="i-lucide-log-in"
        label="Log in"
        :ui="WRAPPING_LABEL"
        :to="loginHref"
        external
      />
      <UButton
        v-else
        data-test="answer-retry"
        color="neutral"
        variant="outline"
        size="xs"
        icon="i-lucide-rotate-cw"
        label="Try again"
        :ui="WRAPPING_LABEL"
        @click="emit('retry')"
      />
    </template>
  </UAlert>

  <!-- Where the answer came from, at its end: a short warning badge, with the
       sentence behind it on hover, on focus and on a tap. -->
  <UTooltip
    v-else-if="isUngrounded"
    v-model:open="explaining"
    :text="UNGROUNDED_EXPLANATION"
    :delay-duration="100"
    :ui="{ content: 'h-auto max-w-72 items-start py-1.5' }"
    disable-closing-trigger
  >
    <button
      type="button"
      data-test="answer-ungrounded"
      class="mt-1 inline-flex items-center gap-1 rounded-md bg-warning/10 px-1.5 py-0.5 text-xs text-(--ui-warning) hover:bg-warning/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ui-warning)"
      @click="explaining = true"
    >
      <UIcon name="i-lucide-triangle-alert" class="size-3.5" />
      {{ UNGROUNDED_LABEL }}
    </button>
  </UTooltip>

  <!-- Named, not a live region: the panel's own region announces the state,
       and a second one would say it twice. -->
  <UAlert
    v-if="waysOn"
    :data-test="foundNothing ? 'answer-searched-note' : 'answer-no-answer'"
    role="group"
    :aria-label="stateLabel"
    color="neutral"
    variant="subtle"
    class="mt-2"
    :icon="isUnavailable ? 'i-lucide-plug-zap' : 'i-lucide-search-x'"
    :description="isUnavailable
      ? 'Search is unavailable right now, so there was nothing to answer from.'
      : searched"
    :ui="{ description: 'break-words' }"
  >
    <template #actions>
      <UButton
        v-if="isUnavailable"
        data-test="answer-retry"
        color="neutral"
        variant="outline"
        size="xs"
        icon="i-lucide-rotate-cw"
        label="Try again"
        :ui="WRAPPING_LABEL"
        @click="emit('retry')"
      />
      <template v-else>
        <UButton
          data-test="answer-rephrase"
          color="neutral"
          variant="outline"
          size="xs"
          icon="i-lucide-pencil-line"
          label="Ask in other words"
          :ui="WRAPPING_LABEL"
          @click="emit('rephrase')"
        />
        <UButton
          data-test="answer-search"
          color="neutral"
          variant="outline"
          size="xs"
          icon="i-lucide-search"
          label="Search the pages yourself"
          :ui="WRAPPING_LABEL"
          :to="searchHref"
        />
        <!-- The knowledge base has no answer because nobody has written it
             yet: writing it is the third way on. -->
        <NewPageButton
          label="Write the page"
          color="neutral"
          variant="outline"
          size="xs"
        />
      </template>
    </template>
  </UAlert>
</template>
