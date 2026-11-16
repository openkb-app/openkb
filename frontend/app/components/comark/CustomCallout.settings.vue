<script setup lang="ts">
import { computed } from 'vue'
import { labelOfComarkName } from '#shared/utils/comark-components'
import type { ComarkComponentDeclaration, ComarkPropControl, ComarkPropDeclaration } from '#shared/utils/comark-components'

/** The callout's settings menu (`CustomCallout.editor.ts`): its type as a select over the block's corner, taking no height. */
const props = defineProps<{
  declaration: ComarkComponentDeclaration
  menuProps: Record<string, ComarkPropDeclaration>
  values: Record<string, unknown>
  controls?: Record<string, ComarkPropControl>
}>()
const emit = defineEmits<{ change: [name: string, value: unknown] }>()

/** Each type with its label and icon. */
const typeItems = computed(() => (props.menuProps.type?.values ?? []).map(value => ({
  label: labelOfComarkName(value),
  value,
  ...(props.controls?.type?.icons?.[value] ? { icon: props.controls.type.icons[value] } : {}),
})))
</script>

<template>
  <div class="absolute right-2 top-3 flex gap-1" contenteditable="false" data-test="component-controls">
    <USelect
      :model-value="String(values.type ?? menuProps.type?.default ?? '')"
      :items="typeItems"
      value-key="value"
      size="xs"
      variant="outline"
      aria-label="Callout type"
      :ui="{ content: 'min-w-40' }"
      @update:model-value="(value: string) => emit('change', 'type', value)"
    />
  </div>
</template>
