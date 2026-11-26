<script setup lang="ts">
import { ref, useSlots, watch } from 'vue'
import { usePrintRender } from '~/composables/usePrintRender'

interface Props {
  summary?: string
  /**
   * Starts expanded.
   * @notIndexed
   */
  open?: boolean
}
const props = withDefaults(defineProps<Props>(), { open: false })

defineComarkComponent<Props>({
  label: 'Collapsible section',
  icon: 'i-lucide-chevrons-down-up',
  description: 'A titled section readers open and close',
  props: {
    open: { label: 'Open by default' },
  },
})
const slots = useSlots()
const printRender = usePrintRender()

/** On for a render that is a print render from the start: the export's. */
const openForPrint = printRender.value

/**
 * A browser print opens the section and gives the reader's state back after.
 * Sync, so the section is open before the browser takes the page.
 */
const section = ref<HTMLElement>()
let openBeforePrint = props.open
watch(printRender, (on) => {
  const element = section.value
  if (!(element instanceof HTMLDetailsElement)) {
    return
  }
  if (on) {
    openBeforePrint = element.open
    element.open = true
    return
  }
  element.open = openBeforePrint
}, { flush: 'sync' })
</script>

<template>
  <!-- Read page: the native element. A closed body stays in the page, so a link
       to a block inside it has a target, and it opens without JavaScript.
       Editor (fills `marker`): plain elements, since its summary holds a field
       and a button, which a native summary may not contain.
       A print render opens it; the print CSS shows the body of one a browser
       print caught closed. -->
  <component
    :is="slots.marker ? 'div' : 'details'"
    ref="section"
    :open="open || openForPrint ? '' : undefined"
    data-test="details"
    class="group my-5 print:break-inside-avoid print:details-content:[content-visibility:visible] rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-900/60 px-5 py-4"
  >
    <component
      :is="slots.marker ? 'div' : 'summary'"
      class="flex list-none items-center gap-2 font-semibold [&::-webkit-details-marker]:hidden"
      :class="{ 'cursor-pointer': !slots.marker }"
    >
      <!-- The editor part puts its open / close button here. -->
      <slot name="marker">
        <UIcon name="i-lucide-chevron-right" class="size-4 shrink-0 transition-transform group-open:rotate-90" />
      </slot>
      <!-- Without a summary it reads "Details", as the native element does. -->
      <span class="min-w-0 flex-1"><slot name="summary">{{ summary || 'Details' }}</slot></span>
    </component>
    <div v-show="open || !slots.marker" class="okb-box-body okb-prose-box mt-2">
      <slot />
    </div>
  </component>
</template>
