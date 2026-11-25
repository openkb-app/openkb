<script setup lang="ts">
/**
 * What the assistant searched for on a turn, one line per search.
 *
 * Shown above the answer from the first search on, so the reader sees what is
 * being looked up while the answer is still loading.
 */
// Explicit, not auto-imported: the component is rendered by its own vitest
// suite outside a Nuxt app.
import type { ToolSearch } from '~/utils/chat-answer'

defineProps<{
  /** The searches the turn ran, in order. */
  searches: ToolSearch[]
}>()

/** What a finished search found, in words. */
function hitsLabel(search: ToolSearch): string {
  if (search.running) return 'searching…'
  if (search.hits === undefined) return ''
  return `${search.hits} hit${search.hits === 1 ? '' : 's'}`
}
</script>

<template>
  <div
    v-if="searches.length"
    data-test="chat-searched-for"
    class="mb-2 text-[11.5px] text-(--ui-text-muted)"
  >
    <span class="font-semibold">Searched for:</span>
    <ul class="mt-0.5 flex flex-col gap-0.5" aria-live="polite">
      <li
        v-for="search in searches"
        :key="search.toolCallId"
        data-test="chat-search"
        :data-search-running="search.running ? 'true' : 'false'"
        class="flex min-w-0 items-baseline gap-1.5"
      >
        <UIcon
          :name="search.running ? 'i-lucide-loader-circle' : 'i-lucide-search'"
          class="size-3 shrink-0 self-center"
          :class="search.running ? 'animate-spin' : ''"
        />
        <span class="min-w-0 truncate">
          <span v-if="search.query.terms" class="font-mono text-(--ui-text-toned)" data-test="chat-search-terms">{{ search.query.terms }}</span>
          <span v-if="search.query.terms && search.query.question"> · </span>
          <span v-if="search.query.question" class="italic" data-test="chat-search-question">{{ search.query.question }}</span>
        </span>
        <!-- Spoken apart from the query it follows. -->
        <span v-if="hitsLabel(search)" class="sr-only">, </span>
        <span class="ml-auto shrink-0 text-[10.5px] text-(--ui-text-dimmed)" data-test="chat-search-hits">{{ hitsLabel(search) }}</span>
      </li>
    </ul>
  </div>
</template>
