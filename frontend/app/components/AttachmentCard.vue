<script setup lang="ts">
/**
 * The file card of a page file (ADR 0020): a thumbnail for an image, an icon
 * by MIME type otherwise, the name linking
 * to the file, size, a download link, and the author's optional description.
 * Slots: `description` replaces the description, `actions` adds buttons.
 * `inline` is the link alone, for a file
 * mentioned inside a sentence. No file is a placeholder: the file is gone, or
 * not readable for this reader (yet — a peer's fresh upload, until the next
 * checkpoint).
 */
import { fileDownloadUrl, fileIcon, formatFileSize, type ResolvedFile } from '#shared/utils/files'

const props = defineProps<{
  file: ResolvedFile | null
  description?: string | null
  inline?: boolean
  /** The inline link's own words; the file name without them. */
  label?: string | null
  /**
   * A small line under the name: uploader and date. NuxtTime writes the date
   * in the reader's locale before hydration, so it never mismatches the
   * server's.
   */
  uploaded?: boolean
  /** Still resolving: says so instead of "not available". */
  pending?: boolean
}>()

const size = computed(() => formatFileSize(props.file?.size))
</script>

<template>
  <a
    v-if="file && inline"
    :href="file.url"
    target="_blank"
    rel="noopener"
    class="inline-flex items-baseline gap-1"
    data-test="attachment-link"
  >
    <UIcon :name="fileIcon(file.mime)" class="size-4 self-center" aria-hidden="true" /><slot name="label">{{ label || file.name }}</slot>
  </a>
  <span v-else-if="inline && !pending" data-test="attachment-placeholder">
    <slot name="label">{{ label || 'File' }}</slot>
    <span class="text-sm text-muted"> (file not available)</span>
  </span>
  <div
    v-else-if="file"
    class="not-prose flex items-center gap-3 rounded-lg border border-default bg-elevated/40 px-4 py-3"
    data-test="attachment-card"
  >
    <img v-if="file.mime.startsWith('image/')" :src="file.url" alt="" loading="lazy" class="size-10 shrink-0 rounded object-cover">
    <UIcon v-else :name="fileIcon(file.mime)" class="size-6 shrink-0 text-muted" aria-hidden="true" />
    <div class="min-w-0 flex-1">
      <a :href="file.url" target="_blank" rel="noopener" class="inline-block max-w-full truncate align-top font-medium">{{ file.name }}</a>
      <slot name="description">
        <p v-if="description" class="text-sm text-muted" data-test="attachment-description">
          {{ description }}
        </p>
      </slot>
      <p v-if="uploaded && (file.owner || file.created)" class="text-xs text-muted">
        {{ file.owner }}<template v-if="file.owner && file.created"> · </template><NuxtTime v-if="file.created" :datetime="file.created" />
      </p>
    </div>
    <span v-if="size" class="shrink-0 text-sm text-muted">{{ size }}</span>
    <a
      :href="fileDownloadUrl(file.url)"
      download
      target="_blank"
      rel="noopener"
      :aria-label="`Download ${file.name}`"
      class="shrink-0 rounded-md p-1.5 text-muted hover:bg-elevated hover:text-default"
      data-test="attachment-download"
    >
      <UIcon name="i-lucide-download" class="block size-4" aria-hidden="true" />
    </a>
    <slot name="actions" />
  </div>
  <component
    :is="inline ? 'span' : 'div'"
    v-else
    :class="inline
      ? 'inline-flex items-center text-sm text-muted'
      : 'flex items-center rounded-lg border border-dashed border-default px-4 py-3 text-sm text-muted'"
    data-test="attachment-placeholder"
  >
    <template v-if="pending">
      <UIcon name="i-lucide-loader-circle" class="mr-2 size-4 animate-spin" aria-hidden="true" /> Loading file…
    </template>
    <template v-else>
      <UIcon name="i-lucide-file-x" class="mr-2 size-4" aria-hidden="true" /> File not available
    </template>
    <span v-if="!inline && $slots.actions" class="ml-auto"><slot name="actions" /></span>
  </component>
</template>
