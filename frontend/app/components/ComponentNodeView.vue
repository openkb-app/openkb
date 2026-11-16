<script setup lang="ts">
import { NodeViewContent, NodeViewWrapper } from '@tiptap/vue-3'
import type { NodeViewProps } from '@tiptap/vue-3'
import { useElementVisibility } from '@vueuse/core'
import { computed, useTemplateRef } from 'vue'
import ComponentSettingsMenu from './ComponentSettingsMenu.vue'
import { comarkEditorParts } from '#okb-comark-editor-parts'
import { comarkVueComponents } from '#okb-comark-vue-components'
import { comarkComponentDeclarations, labelOfComarkName } from '#shared/utils/comark-components'

/**
 * The editor's node view of every block component (ADR 0025): the read
 * component inside Tiptap's wrapper, the body in its default slot, a field in
 * each slot named after a text prop, and a settings menu for the other props,
 * mounted while the block is in the viewport.
 */
const props = defineProps<NodeViewProps>()
const declaration = comarkComponentDeclarations[props.node.type.name]!
const component = comarkVueComponents[declaration.tag]
const editorPart = comarkEditorParts[declaration.tag]
const settingsMenu = editorPart?.settingsMenu ?? ComponentSettingsMenu
const componentLabel = labelOfComarkName(declaration.tag)
const menuProps = Object.fromEntries(Object.entries(declaration.props).filter(([name]) => !declaration.propsEditedInPlace.includes(name)))
const hasSettingsMenu = Object.keys(menuProps).length > 0

// The same object while the stored props stay: typing in the body re-renders no control.
const componentProps = computed<Record<string, unknown>>((previous) => {
  const next = Object.fromEntries(Object.keys(declaration.props).map(name => [name, props.node.attrs[name] ?? undefined]))
  return previous && Object.keys(next).every(name => previous[name] === next[name]) ? previous : next
})

/** Stores a field's text on the node. */
function storeFieldText(name: string, event: Event) {
  props.updateAttributes({ [name]: (event.target as HTMLInputElement).value })
}

const wrapper = useTemplateRef<InstanceType<typeof NodeViewWrapper>>('wrapper')
const inViewport = useElementVisibility(wrapper)
</script>

<template>
  <NodeViewWrapper ref="wrapper" class="okb-component-node-view relative">
    <component :is="component" v-bind="componentProps">
      <template v-for="name in declaration.propsEditedInPlace" :key="name" #[name]>
        <!-- Takes the look of the slot it stands in. -->
        <input
          :value="componentProps[name] ?? ''"
          :placeholder="`${componentLabel} ${name}…`"
          :aria-label="`${componentLabel} ${name}`"
          contenteditable="false"
          class="block w-full border-0 bg-transparent p-0 [font:inherit] [letter-spacing:inherit] [text-transform:inherit] [color:inherit] focus:outline-none focus:ring-0"
          @input="storeFieldText(name, $event)"
        >
      </template>
      <template v-if="declaration.slot" #default>
        <NodeViewContent class="okb-prose-compact" />
      </template>
    </component>
    <component
      :is="settingsMenu"
      v-if="hasSettingsMenu && inViewport"
      :declaration="declaration"
      :menu-props="menuProps"
      :values="componentProps"
      :controls="editorPart?.controls"
      @change="(name: string, value: unknown) => updateAttributes({ [name]: value })"
    />
  </NodeViewWrapper>
</template>
