<script setup lang="ts">
import { labelOfComarkName } from '#shared/utils/comark-components'
import type { ComarkComponentDeclaration, ComarkPropControl, ComarkPropDeclaration } from '#shared/utils/comark-components'

/**
 * The default settings menu of a block component: a gear in the block's
 * top-right corner, opening a form of its props. A change applies at once.
 * The form mounts when the menu opens.
 */
const props = defineProps<{
  declaration: ComarkComponentDeclaration
  /** The props the menu edits: the stored props less those edited in place. */
  menuProps: Record<string, ComarkPropDeclaration>
  values: Record<string, unknown>
  controls?: Record<string, ComarkPropControl>
}>()
const emit = defineEmits<{ change: [name: string, value: unknown] }>()

const componentLabel = labelOfComarkName(props.declaration.tag)

/** The select's items of an enum prop: each value with its label and the icon the component's editor part gives it. */
function enumItemsOfProp(name: string, prop: ComarkPropDeclaration) {
  return (prop.values ?? []).map(value => ({
    label: labelOfComarkName(value),
    value,
    ...(props.controls?.[name]?.icons?.[value] ? { icon: props.controls[name].icons[value] } : {}),
  }))
}

/** Emits a text or number field's value; an empty number field is unset. */
function emitFieldValue(name: string, prop: ComarkPropDeclaration, value: string | number) {
  emit('change', name, prop.kind === 'number' ? (value === '' ? null : Number(value)) : String(value))
}
</script>

<template>
  <div class="absolute right-2 top-2" contenteditable="false" data-test="component-settings">
    <UPopover :content="{ align: 'end' }">
      <UButton
        icon="i-lucide-settings"
        size="xs"
        color="neutral"
        variant="ghost"
        :aria-label="`${componentLabel} settings`"
      />
      <template #content>
        <div class="w-64 space-y-3 p-3" data-test="component-settings-form">
          <UFormField
            v-for="(prop, name) in menuProps"
            :key="name"
            :label="controls?.[name]?.label ?? labelOfComarkName(String(name))"
            :name="String(name)"
          >
            <USelect
              v-if="prop.kind === 'enum'"
              :model-value="String(values[name] ?? prop.default ?? '')"
              :items="enumItemsOfProp(String(name), prop)"
              value-key="value"
              class="w-full"
              @update:model-value="(value: string) => emit('change', String(name), value)"
            />
            <USwitch
              v-else-if="prop.kind === 'boolean'"
              :model-value="values[name] === true"
              @update:model-value="(value: boolean) => emit('change', String(name), value)"
            />
            <UInput
              v-else
              :model-value="String(values[name] ?? '')"
              :type="prop.kind === 'number' ? 'number' : 'text'"
              class="w-full"
              @update:model-value="(value: string | number) => emitFieldValue(String(name), prop, value)"
            />
          </UFormField>
        </div>
      </template>
    </UPopover>
  </div>
</template>
