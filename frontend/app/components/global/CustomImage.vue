<script setup lang="ts">
/**
 * Renderer for an `::image{media="…"}` embed. The comark tree passes
 * (`shared/utils/comark-tree.ts`) have already resolved the media UUID to
 * `src`/`alt`/`width`/`height`; a missing `src` means the media is gone or the
 * viewer may not see it, and a placeholder stands in. `inline` is an embed
 * sitting in a paragraph, where a figure may not go.
 *
 * Neither wrapper states a margin: an image is a block of the column like any
 * other, and `okb-prose` sets the rhythm for both modes.
 */
defineProps<{
  media?: string
  src?: string
  alt?: string
  width?: number
  height?: number
  inline?: boolean
}>()
</script>

<template>
  <component :is="inline ? 'span' : 'figure'" v-if="src">
    <img
      :src="src"
      :alt="alt || undefined"
      :width="width || undefined"
      :height="height || undefined"
      :class="inline ? 'inline max-w-full align-middle' : 'mx-auto max-w-full'"
      loading="lazy"
    >
  </component>
  <component
    :is="inline ? 'span' : 'div'"
    v-else
    :class="inline
      ? 'inline-flex items-center text-sm text-muted'
      : 'flex h-32 items-center justify-center rounded-lg border border-dashed border-default text-sm text-muted'"
  >
    <UIcon name="i-lucide-image-off" class="mr-2 size-4" /> Image unavailable
  </component>
</template>
