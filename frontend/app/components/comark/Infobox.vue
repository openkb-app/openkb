<script setup lang="ts">
import { useSlots } from 'vue'

interface Props {
  title?: string
}
defineProps<Props>()

defineComarkComponent<Props>({
  label: 'Infobox',
  icon: 'i-lucide-square',
  description: 'Titled bordered box',
  placeholder: 'New infobox — set a title above and edit text here.',
  props: {
    title: { example: 'Info' },
  },
})
const slots = useSlots()
</script>

<template>
  <section
    data-test="infobox"
    class="my-5 rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-900/60 px-5 py-4"
  >
    <!-- Chrome inside a prose body states its own scale as important:
         `okb-prose` styles by descendant selector, so its heading classes reach
         this label at the same specificity as the label's own.
         The editor fills the `title` slot with its field, shown even when empty. -->
    <h3
      v-if="title || slots.title"
      class="okb-box-title text-xs! font-semibold! uppercase tracking-wide text-gray-600! dark:text-gray-400! in-[.ProseMirror]:text-gray-700! dark:in-[.ProseMirror]:text-gray-300! mt-0! mb-2!"
    >
      <slot name="title">{{ title }}</slot>
    </h3>
    <!-- The body needs a box of its own: the title is a sibling, so without one
         the first block is never `:first-child` and keeps its top margin. -->
    <div class="okb-box-body okb-prose-compact">
      <slot />
    </div>
  </section>
</template>
