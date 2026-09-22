<script setup lang="ts">
/**
 * What the assistant did on a turn, under its answer: which tools it called,
 * with which arguments, and what came back.
 *
 * Collapsed to one line, because a reader who is reading the answer is not
 * reading this. It opens onto the calls in the order they happened.
 */
// Explicit, not auto-imported: the component is rendered by its own vitest
// suite outside a Nuxt app.
import { computed, ref, useId } from 'vue'
import { toolRunsLabel, type ToolRun } from '~/utils/chat-answer'

const props = defineProps<{
  /** The calls the turn made, in order. */
  runs: ToolRun[]
}>()

const open = ref(false)
const listId = useId()

const label = computed(() => toolRunsLabel(props.runs))
const failed = computed(() => props.runs.some(r => r.failed))

/** Arguments and results as JSON a reader can follow. */
function pretty(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2)
}

/** How long a call took, once it is over. */
function took(run: ToolRun): string {
  if (run.running) return 'running'
  return run.ms === undefined ? '' : `${run.ms} ms`
}
</script>

<template>
  <div
    v-if="runs.length"
    data-test="tool-calls"
    class="mt-3 rounded-md border border-(--ui-border-muted) bg-(--ui-bg-muted) p-2"
  >
    <button
      type="button"
      data-test="tool-calls-toggle"
      :aria-expanded="open"
      :aria-controls="listId"
      class="flex w-full items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide"
      :class="failed ? 'text-(--ui-warning)' : 'text-(--ui-text-muted)'"
      @click="open = !open"
    >
      <UIcon :name="failed ? 'i-lucide-triangle-alert' : 'i-lucide-wrench'" class="size-3 shrink-0" />
      <span class="min-w-0 truncate text-left">{{ label }}</span>
      <UIcon
        name="i-lucide-chevron-down"
        class="ml-auto size-3 shrink-0 transition-transform"
        :class="open ? 'rotate-180' : ''"
      />
    </button>

    <ul
      v-show="open"
      :id="listId"
      data-test="tool-calls-list"
      class="mt-2 flex flex-col gap-2"
    >
      <li
        v-for="run in runs"
        :key="run.toolCallId"
        data-test="tool-call"
        :data-tool-failed="run.failed ? 'true' : 'false'"
        class="rounded border border-(--ui-border-muted) bg-(--ui-bg) p-2"
      >
        <div class="flex items-baseline gap-2">
          <span
            data-test="tool-call-name"
            class="min-w-0 flex-1 break-all font-mono text-[11px] font-medium text-(--ui-text-highlighted)"
          >{{ run.name }}</span>
          <span data-test="tool-call-took" class="shrink-0 text-[10px] text-(--ui-text-dimmed)">
            {{ took(run) }}
          </span>
        </div>

        <div class="mt-1 text-[10px] font-semibold uppercase tracking-wide text-(--ui-text-dimmed)">
          Arguments
        </div>
        <!-- Focusable, so a long block is reachable by keyboard as well as by
             pointer. -->
        <pre
          data-test="tool-call-input"
          tabindex="0"
          class="max-h-40 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-snug text-(--ui-text-muted)"
        >{{ pretty(run.input) }}</pre>

        <template v-if="run.failed">
          <div class="mt-1 text-[10px] font-semibold uppercase tracking-wide text-(--ui-warning)">
            Failed
          </div>
          <p data-test="tool-call-error" class="break-words text-[11px] leading-snug text-(--ui-warning)">
            {{ run.errorText }}
          </p>
        </template>
        <template v-else-if="!run.running">
          <div class="mt-1 text-[10px] font-semibold uppercase tracking-wide text-(--ui-text-dimmed)">
            Result
          </div>
          <pre
            data-test="tool-call-output"
            tabindex="0"
            class="max-h-40 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-snug text-(--ui-text-muted)"
          >{{ pretty(run.output) }}</pre>
        </template>
      </li>
    </ul>
  </div>
</template>
