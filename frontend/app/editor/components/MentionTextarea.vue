<script setup lang="ts">
// Explicit, not auto-imported: the drawer around it is rendered by its own
// vitest suite outside a Nuxt app.
import { computed, ref } from 'vue'
import { draftRuns, type AssigneeCandidate } from '../comment-assignee'

/**
 * The comment composer's field: a textarea with the mentions in it drawn as
 * chips behind the text, so a name reads as a name and not as prose.
 *
 * A textarea cannot style part of its value, so the chips are an echo of the
 * same words under it — same font, same box, scrolled together — and the ink
 * the reader sees is still the textarea's own.
 */
defineOptions({ inheritAttrs: false })

const props = defineProps<{
  candidates: readonly AssigneeCandidate[]
  /** The reader's account, so their own agent echoes under the name they typed. */
  viewerUid?: number | null
  rows?: number
}>()

const text = defineModel<string>({ required: true })

const runs = computed(() => draftRuns(text.value, props.candidates, props.viewerUid ?? null))

const echo = ref<HTMLElement | null>(null)

function syncScroll(event: Event): void {
  if (echo.value) echo.value.scrollTop = (event.target as HTMLTextAreaElement).scrollTop
}
</script>

<template>
  <div class="okb-mention-field relative rounded-md bg-default">
    <!-- The same box the textarea draws its own text in, so the chips fall
         where the words do. -->
    <div
      ref="echo"
      aria-hidden="true"
      class="okb-mention-echo-layer pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-2.5 py-1.5 text-transparent"
      data-testid="mention-echo"
    >
      <span
        v-for="(run, at) in runs"
        :key="at"
        :class="run.mention ? ['okb-mention-echo', run.mention.via ? 'okb-mention-echo--agent' : ''] : undefined"
      >{{ run.text }}</span>
    </div>
    <UTextarea
      v-model="text"
      v-bind="$attrs"
      :rows="rows ?? 3"
      class="relative w-full"
      @scroll="syncScroll"
    />
  </div>
</template>
