<script setup lang="ts">
/**
 * Draws a mermaid fence with Pele. The server's SVG shows until `pele/lazy`
 * takes over the element, loading only the diagram type the source names and
 * laying it out to the container width.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Mounted } from 'pele'
import { fenceError, type FenceError } from '#shared/utils/fences'
import { PELE_OPTIONS } from './pele-options'

/** The fence contract's props (`FenceProps` in shared/utils/fences.ts). */
const props = defineProps<{
  source: string
  html?: string
  preview?: boolean
}>()

const emit = defineEmits<{
  error: [error: FenceError | null]
}>()

const host = ref<HTMLElement>()

let mounted: Mounted | undefined
let destroyed = false
/** The latest draw; an older one returns once it is overtaken. */
let latest = 0

const options = {
  ...PELE_OPTIONS,
  zoom: false as const,
  onRender: () => emit('error', null),
  onError: (err: unknown) => emit('error', fenceError(err)),
}

/** Loads the diagram type a source names, so a sync update can render it. */
async function draw(source: string): Promise<void> {
  const seq = ++latest
  const pele = await import('pele/lazy')
  if (seq !== latest || destroyed || !host.value) return
  let type = null
  try {
    type = pele.detectType(source)
  }
  catch {
    // An undetectable source reports itself through the render.
  }
  await pele.load(type).catch(() => false)
  if (seq !== latest || destroyed || !host.value) return
  if (mounted) mounted.update(source, options)
  else mounted = pele.mount(host.value, source, options)
}

onMounted(() => void draw(props.source))

watch(() => props.source, source => void draw(source))

onBeforeUnmount(() => {
  destroyed = true
  mounted?.destroy()
})
</script>

<template>
  <!-- Pele owns this element's children once mounted. -->
  <div
    ref="host"
    class="okb-diagram-canvas"
    v-html="html"
  />
</template>

<style>
/* Pele draws with these variables, so a colour mode switch restyles a
   diagram without re-rendering it. */
.okb-diagram-canvas {
  --pele-bg: var(--ui-bg);
  --pele-fg: var(--ui-text-highlighted);
  --pele-muted: var(--ui-text-muted);
  --pele-line: var(--ui-text-toned);
  --pele-surface: var(--ui-bg-elevated);
  --pele-surface-alt: var(--ui-bg-accented);
  --pele-border: var(--ui-border-accented);
  --pele-accent: var(--ui-primary);
  --pele-error: var(--ui-error);
  --pele-font: var(--font-sans);
  --pele-font-mono: var(--font-mono);
  --pele-radius: var(--ui-radius);
  --pele-series-1: var(--color-primary-500);
  --pele-series-2: var(--color-agent-500);
  --pele-series-3: var(--color-warning-500);
  --pele-series-4: var(--color-error-500);
  --pele-series-5: var(--color-info-500);
  --pele-series-6: var(--color-neutral-500);
  --pele-series-7: var(--color-primary-300);
  --pele-series-8: var(--color-warning-300);
  overflow-x: auto;
}
/* The frame shows the error, with its place. */
.okb-diagram-canvas > .pele-error {
  display: none;
}
</style>
