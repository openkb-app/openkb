<script setup lang="ts">
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'

/**
 * Editor NodeView for `::embed{file title}` (app/editor/nodes/embed.ts): the
 * frame the read page shows, resolved through /api/files/resolve. The title is
 * edited below it while the embed is selected or has one.
 */
const props = defineProps(nodeViewProps)

const uuid = computed(() => props.node.attrs.file as string | null)
const { file, state } = usePageFile(uuid)

// Typed text stays local until `change`, so a re-render keeps it.
const title = ref('')
watch(() => props.node.attrs.title as string | null, (value) => {
  title.value = value ?? ''
}, { immediate: true })

const editingTitle = ref(false)
const showTitle = computed(() => props.editor.isEditable && (props.selected || editingTitle.value || !!title.value))

/** A plain click on a link selects the embed; Ctrl/Cmd+Click opens it (LinkOpen). The download button stays a link. */
function keepClick(event: MouseEvent): void {
  if (props.editor.isEditable && !event.ctrlKey && !event.metaKey && (event.target as Element).closest('a[href]:not([download])')) event.preventDefault()
}

function saveTitle(): void {
  props.updateAttributes({ title: title.value || null })
}
</script>

<template>
  <NodeViewWrapper
    :id="(props.node.attrs.id as string | null) || undefined"
    :class="{ 'rounded-lg ring-2 ring-primary': props.selected }"
    data-type="embed"
    contenteditable="false"
    @click="keepClick"
  >
    <EmbedFrame :file="file" :title="props.node.attrs.title as string | null" :pending="state === 'loading'" />
    <input
      v-if="showTitle"
      v-model="title"
      placeholder="Add a title"
      aria-label="Embed title"
      class="mt-1 w-full rounded-sm bg-transparent px-1 text-sm text-muted outline-none placeholder:text-dimmed focus:text-default focus-visible:ring-2 focus-visible:ring-primary"
      data-test="embed-title-input"
      @change="saveTitle"
      @focus="editingTitle = true"
      @blur="editingTitle = false"
    >
  </NodeViewWrapper>
</template>
