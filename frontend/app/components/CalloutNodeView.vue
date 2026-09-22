<script setup lang="ts">
import { NodeViewWrapper, NodeViewContent } from '@tiptap/vue-3'
import type { NodeViewProps } from '@tiptap/vue-3'

type CalloutType = 'info' | 'warning' | 'success' | 'danger'

const props = defineProps<NodeViewProps>()

const TYPES: Array<{ label: string, value: CalloutType, icon: string }> = [
  { label: 'Info',    value: 'info',    icon: 'i-lucide-info' },
  { label: 'Warning', value: 'warning', icon: 'i-lucide-alert-triangle' },
  { label: 'Success', value: 'success', icon: 'i-lucide-check-circle' },
  { label: 'Danger',  value: 'danger',  icon: 'i-lucide-octagon-alert' },
]

const calloutType = computed<CalloutType>(() => (props.node.attrs.type as CalloutType) ?? 'info')

// The read callout tints its body per type, so the node view carries the same
// text tone: one look in both modes.
const tone = computed(() => {
  switch (calloutType.value) {
    case 'warning': return { ring: 'ring-amber-300 dark:ring-amber-700',   bg: 'bg-amber-50 dark:bg-amber-950/40',     text: 'text-amber-900 dark:text-amber-100' }
    case 'success': return { ring: 'ring-emerald-300 dark:ring-emerald-700', bg: 'bg-emerald-50 dark:bg-emerald-950/40', text: 'text-emerald-900 dark:text-emerald-100' }
    case 'danger':  return { ring: 'ring-red-300 dark:ring-red-700',       bg: 'bg-red-50 dark:bg-red-950/40',         text: 'text-red-900 dark:text-red-100' }
    default:        return { ring: 'ring-sky-300 dark:ring-sky-700',       bg: 'bg-sky-50 dark:bg-sky-950/40',         text: 'text-sky-900 dark:text-sky-100' }
  }
})
</script>

<template>
  <NodeViewWrapper
    data-test="callout"
    class="my-4 rounded-lg ring-1 px-4 py-3 relative"
    :class="[tone.ring, tone.bg, tone.text]"
  >
    <div class="absolute right-2 top-2" contenteditable="false">
      <USelect
        :model-value="calloutType"
        :items="TYPES"
        value-key="value"
        size="xs"
        variant="outline"
        aria-label="Callout type"
        :ui="{ content: 'min-w-40' }"
        @update:model-value="(v: CalloutType) => updateAttributes({ type: v })"
      />
    </div>
    <!-- `ps-8` is the read callout's icon column (`CustomCallout`: a `size-5`
         icon and `gap-3`). The editor's type control is absolutely positioned,
         so without it the same words wrap at a different width in edit. -->
    <NodeViewContent class="okb-prose-compact ps-8" />
  </NodeViewWrapper>
</template>
