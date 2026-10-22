<script setup lang="ts">
import { computed } from 'vue'
import { parseImageWidth } from '#shared/utils/image-width'
import { loadPhotoSwipe, openLightbox } from '~/utils/image-lightbox'

/**
 * Renderer for an `::image{file="…"}` embed. The comark tree passes
 * (`shared/utils/comark-tree.ts`) have already resolved the page file to
 * `src`; a missing `src` means it is gone or the viewer may not see it, and a
 * placeholder stands in. `inline` is an embed sitting in a paragraph, where a
 * figure may not go. `width` is the fence's percent of the column (`"70%"`).
 *
 * Neither wrapper states a margin: an image is a block of the column like any
 * other, and `okb-prose` sets the rhythm for both modes.
 *
 * The image links to its file; with JS a click opens it large
 * (`utils/image-lightbox.ts`).
 */
const props = defineProps<{
  file?: string
  src?: string
  alt?: string
  width?: string
  inline?: boolean
}>()

const percent = computed(() => parseImageWidth(props.width))

function open(event: MouseEvent) {
  if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  void openLightbox(event.currentTarget as HTMLAnchorElement)
}
</script>

<template>
  <component :is="inline ? 'span' : 'figure'" v-if="src">
    <a
      :href="src"
      :aria-label="alt ? undefined : 'View image'"
      :class="inline ? 'cursor-zoom-in border-0!' : 'mx-auto block w-fit max-w-full cursor-zoom-in border-0!'"
      :style="percent && !inline ? { width: `${percent}%` } : undefined"
      data-lightbox
      @pointerenter.once="loadPhotoSwipe().catch(() => {})"
      @click="open"
    ><img
      :src="src"
      :alt="alt || ''"
      :style="percent && inline ? { width: `${percent}%` } : undefined"
      :class="inline ? 'inline max-w-full align-middle' : ['block max-w-full', { 'w-full': percent }]"
      loading="lazy"
    ></a>
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
