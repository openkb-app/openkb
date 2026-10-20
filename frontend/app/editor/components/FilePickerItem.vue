<script setup lang="ts">
/**
 * One row of the file picker, the same in "On this page" and "My files":
 * a thumbnail for an image (an icon otherwise), the name, a small detail line,
 * and a "Select" hint shown on hover or keyboard focus. The surrounding
 * button (or palette option) is the control.
 */
import { fileIcon, formatFileSize } from '#shared/utils/files'

const props = defineProps<{ name: string, url: string, mime: string, size: number, detail?: string | null }>()

const line = computed(() => [props.detail, formatFileSize(props.size)].filter(Boolean).join(' · '))
</script>

<template>
  <span class="flex w-full min-w-0 items-center gap-3 text-start">
    <img v-if="mime.startsWith('image/')" :src="url" alt="" loading="lazy" class="size-12 shrink-0 rounded object-cover">
    <span v-else class="flex size-12 shrink-0 items-center justify-center rounded bg-elevated">
      <UIcon :name="fileIcon(mime)" class="size-6 text-muted" aria-hidden="true" />
    </span>
    <span class="flex min-w-0 flex-1 flex-col">
      <span class="truncate text-sm text-highlighted">{{ name }}</span>
      <span v-if="line" class="truncate text-xs text-muted">{{ line }}</span>
    </span>
    <span
      class="shrink-0 rounded-md px-2 py-1 text-xs font-medium ring ring-inset ring-accented opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 group-data-highlighted:opacity-100"
      aria-hidden="true"
    >Select</span>
  </span>
</template>
