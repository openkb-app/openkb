<script setup lang="ts">
// Explicit, not auto-imported: the component is rendered by its own vitest
// suite outside a Nuxt app.
import { computed } from 'vue'
import { receiptParts, type Receipt } from '~/utils/chat-receipt'

const props = defineProps<{
  /** What one turn changed. */
  receipt: Receipt
  /** Where the changed blocks link to; null for no link. */
  href: string | null
}>()

/** "Changed" or "Nothing changed". */
const title = computed(() => (props.receipt.changed ? 'Changed' : 'Nothing changed'))

/** What changed, in parts. */
const parts = computed(() => receiptParts(props.receipt))
</script>

<template>
  <!-- Neutral in both states: "Nothing changed" is a state, not an error. -->
  <UAlert
    data-test="answer-receipt"
    :data-receipt-state="receipt.changed ? 'changed' : 'unchanged'"
    role="group"
    :aria-label="title"
    color="neutral"
    variant="outline"
    class="mt-2"
    :icon="receipt.changed ? 'i-lucide-file-pen-line' : 'i-lucide-file-minus'"
    :title="title"
    :ui="{ title: 'break-words', description: 'break-words' }"
  >
    <template #description>
      <template v-if="receipt.changed">
        <template v-for="(part, i) in parts" :key="part.text">
          <template v-if="i > 0">, </template>
          <ULink
            v-if="part.changedBlocks && href"
            :to="href"
            class="underline"
          >{{ part.text }}</ULink>
          <template v-else>{{ part.text }}</template>
        </template>
      </template>
      <template v-else>The assistant wrote no change.</template>
    </template>
  </UAlert>
</template>
