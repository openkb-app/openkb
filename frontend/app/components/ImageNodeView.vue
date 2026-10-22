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
 * Handles on both edges resize a page-file image to a percent of the
 * column; the release commits it in one transaction, so one undo step. The
 * keyboard path is the Size menu in the image bubble. Plain-URL images get
 * no handles: `![alt](src)` has no width.
 *
 * Renders the block id on the wrapper so margins and comments can anchor
 * to it.
 */
const props = defineProps(nodeViewProps)

const fileUuid = computed(() => props.node.attrs.file as string | null)
const { file, state: fileState } = usePageFile(fileUuid)
const src = computed(() => (props.node.attrs.src as string | null) ?? file.value?.url)
const alt = computed(() => props.node.attrs.alt as string | null)

const wrapper = ref<InstanceType<typeof NodeViewWrapper>>()
const frame = ref<HTMLElement>()
/** The width while a handle is dragged, before it is committed. */
const dragWidth = ref<number | null>(null)
const width = computed(() => dragWidth.value ?? (props.node.attrs.width as number | null))

function startResize(event: PointerEvent, side: -1 | 1): void {
  const column = (wrapper.value?.$el as HTMLElement | undefined)?.clientWidth
  const start = frame.value?.offsetWidth
  if (!column || !start) return
  const handle = event.currentTarget as HTMLElement
  handle.setPointerCapture(event.pointerId)
  const startX = event.clientX
  const move = (e: PointerEvent) => {
    // The image is centered: an edge that follows the pointer moves both.
    const px = start + 2 * side * (e.clientX - startX)
    dragWidth.value = Math.min(100, Math.max(MIN_IMAGE_WIDTH, Math.round(px / column * 100)))
  }
  let cancelled = false
  const cancel = () => { cancelled = true }
  const end = () => {
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointercancel', cancel)
    const committed = cancelled ? null : dragWidth.value
    dragWidth.value = null
    if (committed !== null && committed !== props.node.attrs.width) props.updateAttributes({ width: committed })
  }
  handle.addEventListener('pointermove', move)
  // A cancelled touch also loses the capture: it ends the drag without a commit.
  handle.addEventListener('pointercancel', cancel, { once: true })
  handle.addEventListener('lostpointercapture', end, { once: true })
}
</script>

<template>
  <NodeViewWrapper
    ref="wrapper"
    :id="(props.node.attrs.id as string | null) || undefined"
    data-type="image"
  >
    <div
      v-if="src"
      ref="frame"
      class="group relative mx-auto w-fit max-w-full"
      :style="width ? { width: `${width}%` } : undefined"
    >
      <img
        :src="src"
        :alt="alt || undefined"
        class="block max-w-full"
        :class="{ 'w-full': width, 'rounded-lg ring-2 ring-primary': props.selected }"
        draggable="false"
      >
      <template v-if="props.editor.isEditable && fileUuid">
        <!-- Pointer only, the bubble's Size menu is the keyboard path. Outside the image, so a click on a small one selects it. -->
        <button
          v-for="side in ([-1, 1] as const)"
          :key="side"
          type="button"
          tabindex="-1"
          aria-hidden="true"
          :data-resize-handle="side < 0 ? 'left' : 'right'"
          class="absolute top-1/2 h-12 w-2 -translate-y-1/2 cursor-ew-resize touch-none rounded-full bg-primary ring-2 ring-(--ui-bg) opacity-0 transition-opacity group-hover:opacity-100"
          :class="[side < 0 ? '-left-3' : '-right-3', { 'opacity-100': props.selected || dragWidth !== null }]"
          contenteditable="false"
          @pointerdown.prevent="startResize($event, side)"
        />
      </template>
    </div>
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
