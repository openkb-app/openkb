<script setup lang="ts">
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'

/**
 * Live-preview NodeView for the editor's image node (app/editor/nodes/
 * image.ts). Media-library images carry only the media UUID in the
 * document; the display URL is resolved through /api/media/resolve and
 * kept local — it must never enter the collab doc or the stored markdown.
 * Plain-URL images (`![alt](src)`) render their src directly.
 *
 * When the node is selected, an alt input edits the per-embed alt
 * override (empty = fall back to the media entity's own alt at render
 * time).
 *
 * Renders the block id on the wrapper so margins and comments can anchor
 * to it.
 */
const props = defineProps(nodeViewProps)

const resolvedSrc = ref<string | null>(null)
const resolvedAlt = ref<string>('')
const failed = ref(false)

const media = computed(() => props.node.attrs.media as string | null)
const src = computed(() => (props.node.attrs.src as string | null) ?? resolvedSrc.value)
const alt = computed(() => (props.node.attrs.alt as string | null) || resolvedAlt.value)

watch(media, async (uuid) => {
  failed.value = false
  resolvedSrc.value = null
  if (!uuid) return
  try {
    const { items } = await $fetch<{ items: Record<string, { url: string, alt: string }> }>(
      '/api/media/resolve',
      { query: { uuids: uuid } },
    )
    const item = items[uuid]
    if (!item) throw new Error('unknown media')
    resolvedSrc.value = item.url
    resolvedAlt.value = item.alt ?? ''
  }
  catch {
    failed.value = true
  }
}, { immediate: true })
</script>

<template>
  <NodeViewWrapper
    :id="(props.node.attrs.id as string | null) || undefined"
    :class="{ 'rounded-lg ring-2 ring-primary': props.selected }"
    data-type="image"
  >
    <img
      v-if="src"
      :src="src"
      :alt="alt || undefined"
      class="max-w-full"
      draggable="false"
    >
    <div
      v-else
      class="flex h-40 items-center justify-center rounded-lg border border-dashed border-default text-muted"
    >
      <template v-if="failed">
        <UIcon name="i-lucide-image-off" class="mr-2 size-5" /> Media not found
      </template>
      <template v-else>
        <UIcon name="i-lucide-loader-circle" class="mr-2 size-5 animate-spin" /> Loading image…
      </template>
    </div>
    <div v-if="props.selected" class="mt-2 flex items-center gap-2" contenteditable="false">
      <UInput
        :model-value="(props.node.attrs.alt as string | null) ?? ''"
        placeholder="Alt text"
        size="sm"
        class="w-full max-w-sm"
        aria-label="Image alt text"
        @update:model-value="value => props.updateAttributes({ alt: value })"
      />
    </div>
  </NodeViewWrapper>
</template>
