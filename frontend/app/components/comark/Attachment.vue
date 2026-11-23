<script setup lang="ts">
/**
 * Renderer for `::attachment{file="…"}` and the inline `:attachment[Label]{file}`,
 * whose slot holds the label.
 * The comark tree passes have already resolved the file for this reader
 * (`url`, `name`, `size`, `mime`); without them the file is not readable here.
 */
import { useSlots } from 'vue'
import type { ResolvedFile } from '#shared/utils/files'

const slots = useSlots()

const props = defineProps<{
  /** @notIndexed */
  file?: string
  /** @render */
  url?: string
  /** @render */
  name?: string
  /** @render */
  size?: number
  /** @render */
  mime?: string
  description?: string
  /** @render */
  inline?: boolean
}>()

const resolved = computed<ResolvedFile | null>(() => props.url
  ? { url: props.url, name: props.name ?? '', size: props.size ?? 0, mime: props.mime ?? '', owner: null, created: null }
  : null)
</script>

<template>
  <AttachmentCard :file="resolved" :description="description" :inline="inline">
    <template v-if="inline && slots.default" #label>
      <slot />
    </template>
  </AttachmentCard>
</template>
