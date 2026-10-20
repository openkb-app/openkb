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
          v-model="description"
          placeholder="Add a description"
          aria-label="Attachment description"
          class="w-full rounded-sm bg-transparent px-1 -mx-1 text-sm text-muted outline-none placeholder:text-dimmed focus:text-default focus-visible:ring-2 focus-visible:ring-primary"
          data-test="attachment-description-input"
          @change="saveDescription"
        >
      </template>
    </AttachmentCard>
  </NodeViewWrapper>
</template>
