<script setup lang="ts">
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'

/**
 * Live-preview NodeView for the editor's image node (app/editor/nodes/
 * image.ts). Page-file images (`file`, ADR 0020) carry only the file UUID in
 * the document; the display URL is resolved through /api/files/resolve and
 * kept local — it must never enter the collab doc or the stored markdown.
 * Plain-URL images (`![alt](src)`) render their src directly.
 *
 * When the node is selected, an alt input edits the embed's alt text.
 *
 * Renders the block id on the wrapper so margins and comments can anchor
 * to it.
 */
const props = defineProps(nodeViewProps)

const fileUuid = computed(() => props.node.attrs.file as string | null)
const { file, state: fileState } = usePageFile(fileUuid)
const src = computed(() => (props.node.attrs.src as string | null) ?? file.value?.url)
const alt = computed(() => props.node.attrs.alt as string | null)
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
      <template v-if="fileState !== 'loading'">
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
