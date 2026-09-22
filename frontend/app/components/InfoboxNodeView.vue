<script setup lang="ts">
import { NodeViewWrapper, NodeViewContent } from '@tiptap/vue-3'
import type { NodeViewProps } from '@tiptap/vue-3'

const props = defineProps<NodeViewProps>()

const title = computed<string>(() => (props.node.attrs.title as string | undefined) ?? '')

function onTitleInput(event: Event) {
  const value = (event.target as HTMLInputElement).value
  props.updateAttributes({ title: value })
}
</script>

<template>
  <NodeViewWrapper
    data-test="infobox"
    class="my-5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-900/60 px-5 py-4 relative"
  >
    <input
      :value="title"
      placeholder="Infobox title…"
      class="block w-full bg-transparent text-xs font-semibold uppercase tracking-wide text-gray-700 dark:text-gray-300 mb-2 focus:outline-none focus:ring-0 border-0 p-0"
      contenteditable="false"
      @input="onTitleInput"
    >
    <NodeViewContent class="okb-prose-compact" />
  </NodeViewWrapper>
</template>
