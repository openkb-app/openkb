<script setup lang="ts">
/**
 * Renderer for `::embed{file="…" title="…"}`.
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
  title?: string
}>()

const resolved = computed<ResolvedFile | null>(() => props.url
  ? { url: props.url, name: props.name ?? '', size: props.size ?? 0, mime: props.mime ?? '', owner: null, created: null }
  : null)
</script>

<template>
  <EmbedFrame :file="resolved" :title="title" />
</template>
