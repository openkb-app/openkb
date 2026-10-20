<script setup lang="ts">
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'

/**
 * Editor NodeView for `::attachment{file}` and the inline `:attachment[Label]{file}`
 * (app/editor/nodes/attachment.ts): the same file card the read page shows,
 * resolved through /api/files/resolve. Only the UUID and the optional
 * description are in the document; the description is edited in the card.
 */
const props = defineProps(nodeViewProps)

const inline = computed(() => props.node.type.name === 'attachmentInline')
const uuid = computed(() => props.node.attrs.file as string | null)
const { file, state } = usePageFile(uuid)

// Typed text stays local until `change`, so a re-render keeps it.
const description = ref('')
watch(() => props.node.attrs.description as string | null, (value) => {
  description.value = value ?? ''
}, { immediate: true })

// Shown while the card is selected or the field is in use, so an unselected
// card without a description is as tall as on the read page.
const editingDescription = ref(false)
const showDescription = computed(() => props.selected || editingDescription.value || !!description.value)

/** A plain click on the file name selects the card or link; Ctrl/Cmd+Click opens it (LinkOpen). The download button stays a link. */
function keepClick(event: MouseEvent): void {
  if (props.editor.isEditable && !event.ctrlKey && !event.metaKey && (event.target as Element).closest('a[href]:not([download])')) event.preventDefault()
}

function saveDescription(): void {
  props.updateAttributes({ description: description.value || null })
}
</script>

<template>
  <NodeViewWrapper
    :as="inline ? 'span' : 'div'"
    :id="inline ? undefined : ((props.node.attrs.id as string | null) || undefined)"
    :class="{ 'rounded-lg ring-2 ring-primary': props.selected }"
    data-type="attachment"
    contenteditable="false"
    @click="keepClick"
  >
    <AttachmentCard
      :file="file"
      :description="props.node.attrs.description as string | null"
      :inline="inline"
      :label="inline ? (props.node.attrs.label as string | null) : null"
      :pending="state === 'loading'"
    >
      <template v-if="props.editor.isEditable" #description>
        <input
          v-if="showDescription"
          v-model="description"
          placeholder="Add a description"
          aria-label="Attachment description"
          class="w-full rounded-sm bg-transparent px-1 -mx-1 text-sm text-muted outline-none placeholder:text-dimmed focus:text-default focus-visible:ring-2 focus-visible:ring-primary"
          data-test="attachment-description-input"
          @change="saveDescription"
          @focus="editingDescription = true"
          @blur="editingDescription = false"
        >
      </template>
    </AttachmentCard>
  </NodeViewWrapper>
</template>
