<script setup lang="ts">
/**
 * Renderer for `::attachment{file="…"}` and the inline `:attachment[Label]{file}`,
 * whose slot holds the label.
 * The comark tree passes have already resolved the file for this reader
 * (`url`, `name`, `size`, `mime`); without them the file is not readable here.
 */
import type { ResolvedFile } from '#shared/utils/files'

const props = defineProps<{
  file?: string
  url?: string
  name?: string
  size?: number
  mime?: string
  description?: string
  inline?: boolean
}>()

const resolved = computed<ResolvedFile | null>(() => props.url
  ? { url: props.url, name: props.name ?? '', size: props.size ?? 0, mime: props.mime ?? '', owner: null, created: null }
  : null)
</script>

<template>
  <AttachmentCard :file="resolved" :description="description" :inline="inline">
    <template v-if="inline && $slots.default" #label>
      <slot />
    </template>
  </AttachmentCard>
</template>
