<script setup lang="ts">
/**
 * One row of the file picker, the same in "On this page" and "My files":
 * a thumbnail for an image (an icon otherwise), the name, a small detail line,
 * and a "Select" hint shown on hover or keyboard focus. The surrounding
 * button (or palette option) is the control. `compact` (the longer "My files"
 * list) takes a smaller thumbnail and puts the detail line beside the name.
 */
import { fileIcon, formatFileSize } from '#shared/utils/files'

const props = defineProps<{ name: string, url: string, mime: string, size: number, detail?: string | null, compact?: boolean }>()

const line = computed(() => [props.detail, formatFileSize(props.size)].filter(Boolean).join(' · '))
</script>

<template>
  <span class="flex w-full min-w-0 items-center text-start" :class="compact ? 'gap-2' : 'gap-3'">
    <img v-if="mime.startsWith('image/')" :src="url" alt="" loading="lazy" class="shrink-0 rounded object-cover" :class="compact ? 'size-7' : 'size-12'">
    <span v-else class="flex shrink-0 items-center justify-center rounded bg-elevated" :class="compact ? 'size-7' : 'size-12'">
      <UIcon :name="fileIcon(mime)" class="text-muted" :class="compact ? 'size-4' : 'size-6'" aria-hidden="true" />
    </span>
    <span class="flex min-w-0 flex-1" :class="compact ? 'items-baseline gap-2' : 'flex-col'">
      <span class="truncate text-sm text-highlighted">{{ name }}</span>
      <span v-if="line" class="truncate text-xs text-muted" :class="{ 'shrink-0 max-w-1/2': compact }">{{ line }}</span>
    </span>
    <span
      class="shrink-0 rounded-md px-2 py-1 text-xs font-medium ring ring-inset ring-accented opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 group-data-highlighted:opacity-100"
      aria-hidden="true"
    >Select</span>
  </span>
</template>
