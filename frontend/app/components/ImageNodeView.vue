<script setup lang="ts">
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'

/**
 * Live-preview NodeView for the editor's image node (app/editor/nodes/
 * image.ts). Media-library images carry only the media UUID in the
 * document; the display URL is resolved through /api/media/resolve and
 * kept local — it must never enter the collab doc or the stored markdown.
 * Page-file images (`file`, ADR 0020) resolve through /api/files/resolve the
 * same way. Plain-URL images (`![alt](src)`) render their src directly.
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
const fileUuid = computed(() => props.node.attrs.file as string | null)
const { file, state: fileState } = usePageFile(fileUuid)
const src = computed(() => (props.node.attrs.src as string | null) ?? file.value?.url ?? resolvedSrc.value)
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
    data-type="image"
  >
    <img
      v-if="src"
      :src="src"
      :alt="alt || undefined"
      class="mx-auto block max-w-full"
      :class="{ 'rounded-lg ring-2 ring-primary': props.selected }"
      draggable="false"
    >
    <div
      v-else
      class="flex h-40 items-center justify-center rounded-lg border border-dashed border-default text-muted"
      :class="{ 'ring-2 ring-primary': props.selected }"
    >
      <template v-if="failed || fileState === 'unavailable'">
        <UIcon name="i-lucide-image-off" class="mr-2 size-5" /> Image not available
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
