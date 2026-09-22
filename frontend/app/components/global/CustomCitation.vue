<script setup lang="ts">
/**
 * One cited source in the prose, as the badge the marker `[n]` renders as.
 *
 * A real link, so middle-click, open-in-new-tab, copy-link and a screen
 * reader all read it as one (WCAG 4.1.2); `ChatPanel.vue` watches the click
 * by the `cite-chip` class. `okb-prose` styles every anchor in the body at
 * higher specificity, so the badge carries its own colour, weight and edge.
 *
 * A page's own citations (`:citation`, #shared/utils/citations.ts) render
 * the same chip and may carry a `state`: a source whose text moved since it was
 * cited, or one that is no longer there. The state carries a glyph as well as
 * a colour, and is named in the chip's own label and tooltip.
 */
import { CITE_STATE_GLYPH, CITE_STATE_NOTE, type CiteState } from '#shared/utils/citations'

const props = defineProps<{
  n: string
  /** Absent where the cited page did not resolve: the chip is then no link. */
  path?: string
  title?: string
  state?: Exclude<CiteState, 'ok'>
}>()

/** A chip with nowhere to lead is not a link — see `path`. */
const NuxtLink = resolveComponent('NuxtLink')

const named = computed(() => (props.title ? `Source ${props.n}: ${props.title}` : `Source ${props.n}`))
const note = computed(() => (props.state ? CITE_STATE_NOTE[props.state] : ''))
const label = computed(() => (note.value ? `${named.value} — ${note.value}` : named.value))

const TONE: Record<Exclude<CiteState, 'ok'>, string> = {
  stale: 'bg-warning text-inverted! hover:bg-warning/80 focus-visible:outline-(--ui-warning)',
  dangling: 'bg-error text-inverted! hover:bg-error/80 focus-visible:outline-(--ui-error)',
}
const tone = computed(() => (props.state
  ? TONE[props.state]
  : 'bg-primary text-inverted! hover:bg-primary-600 focus-visible:outline-(--ui-primary) dark:hover:bg-primary-400'))
</script>

<template>
  <UTooltip :delay-duration="100" :ui="{ content: 'h-auto max-w-72 items-start py-1.5' }">
    <component
      :is="path ? NuxtLink : 'span'"
      :to="path"
      class="cite-chip mx-0.5 inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full border-b-0! px-1.5 align-text-top text-[11px] font-semibold! leading-none focus-visible:outline-2 focus-visible:outline-offset-2"
      :class="[tone, path ? 'cursor-pointer' : 'cursor-help']"
      :data-cite-n="n"
      :data-cite-state="state"
      :aria-label="label"
    >{{ n }}<span v-if="state" aria-hidden="true" class="ms-px">{{ CITE_STATE_GLYPH[state] }}</span></component>

    <template #content>
      <!-- Inside the tooltip's content slot, so its own colours apply. -->
      <span class="flex flex-col gap-0.5 text-left">
        <span class="font-medium">{{ title || `Source ${n}` }}</span>
        <span v-if="path" class="truncate opacity-70">{{ path }}</span>
        <span v-if="note" class="opacity-70">{{ note }}</span>
      </span>
    </template>
  </UTooltip>
</template>
