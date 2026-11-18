<script lang="ts">
let bodyIds = 0
</script>

<script setup lang="ts">
import { NodeViewContent, NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { Selection, type Transaction } from '@tiptap/pm/state'
import { ySyncPluginKey } from '@tiptap/y-tiptap'
import { useElementVisibility } from '@vueuse/core'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'
import CustomDetails from './CustomDetails.vue'
import ComponentSettingsMenu from '../ComponentSettingsMenu.vue'
import { comarkComponentDeclarations, insertedComponentMeta } from '#shared/utils/comark-components'

/**
 * The collapsible section's node view. Open or closed is this user's view;
 * only "Open by default" (`open`) is stored:
 * - on load as stored;
 * - the chevron button toggles it;
 * - open when just inserted, when the caret moves into it, or when
 *   ArrowLeft / ArrowRight jumps over it while closed.
 */
const props = defineProps(nodeViewProps)
const declaration = comarkComponentDeclarations.details!
const menuProps = { open: declaration.props.open! }
const controls = { open: { label: 'Open by default' } }
const bodyId = `okb-details-body-${++bodyIds}`

/** This user's open state; null shows the stored one. */
const shownOpen = ref<boolean | null>(null)
const isOpen = computed(() => shownOpen.value ?? props.node.attrs.open === true)
// A changed default shows at once.
watch(() => props.node.attrs.open, () => { shownOpen.value = null })

const values = computed(() => ({ open: props.node.attrs.open }))

/** Fixed, the state is in `aria-expanded`; the summary tells the sections apart. */
const toggleLabel = computed(() => props.node.attrs.summary ? `Show section content: ${props.node.attrs.summary}` : 'Show section content')

/** Opens or closes the section for this user. */
function toggleShownOpen() {
  shownOpen.value = !isOpen.value
}

/** Whether the caret is in the section's summary or body. */
function isCaretInside(): boolean {
  const pos = props.getPos()
  if (pos === undefined) return false
  const { from } = props.editor.state.selection
  return from > pos && from < pos + props.node.nodeSize
}

/**
 * Where the caret goes in the body when it moved from the block before the
 * section straight to the block after it (start of the body), or back (its end).
 */
function bodyCaretAfterJump(from: number, to: number): Selection | null {
  const pos = props.getPos()
  if (pos === undefined) return null
  const { doc } = props.editor.state
  const end = pos + props.node.nodeSize
  const before = doc.resolve(pos).nodeBefore
  const after = doc.resolve(end).nodeAfter
  if (!before || !after) return null
  const inBefore = (at: number) => at >= pos - before.nodeSize && at <= pos
  const inAfter = (at: number) => at >= end && at <= end + after.nodeSize
  if (inBefore(from) && inAfter(to)) return Selection.findFrom(doc.resolve(pos + 1), 1, true)
  if (inAfter(from) && inBefore(to)) return Selection.findFrom(doc.resolve(end - 1), -1, true)
  return null
}

// Unknown until the view is placed: the transaction that mounts it has run then.
let wasCaretInside: boolean | undefined
queueMicrotask(() => { wasCaretInside ??= isCaretInside() })
let lastHead = props.editor.state.selection.head

/**
 * Opens a closed section for this user, as listed above. A jump over it puts
 * the caret into its body. A click or a collaborator's change never opens it.
 */
function openWhenCaretMovesIn({ transaction }: { transaction: Transaction }) {
  const inside = isCaretInside()
  const from = lastHead
  const to = props.editor.state.selection.head
  const wasInside = wasCaretInside
  wasCaretInside = inside
  lastHead = to
  if (isOpen.value || transaction.getMeta(ySyncPluginKey)) return
  if (inside) {
    if (wasInside === false || transaction.getMeta(insertedComponentMeta)) shownOpen.value = true
    return
  }
  if (transaction.docChanged || transaction.getMeta('pointer') || !props.editor.state.selection.empty) return
  if (!bodyCaretAfterJump(from, to)) return
  shownOpen.value = true
  // The body is hidden until Vue shows it; a caret is placed into shown text only.
  void nextTick(() => {
    if (props.editor.state.selection.head !== to) return
    const caret = bodyCaretAfterJump(from, to)
    if (caret) props.editor.view.dispatch(props.editor.state.tr.setSelection(caret).scrollIntoView())
  })
}
onMounted(() => props.editor.on('selectionUpdate', openWhenCaretMovesIn))
onBeforeUnmount(() => props.editor.off('selectionUpdate', openWhenCaretMovesIn))

/** Stores the summary field's text on the node. */
function storeSummaryText(event: Event) {
  props.updateAttributes({ summary: (event.target as HTMLInputElement).value })
}

const wrapper = useTemplateRef<InstanceType<typeof NodeViewWrapper>>('wrapper')
const inViewport = useElementVisibility(wrapper)
</script>

<template>
  <NodeViewWrapper ref="wrapper" class="okb-component-node-view relative">
    <CustomDetails :summary="node.attrs.summary ?? undefined" :open="isOpen">
      <template #marker>
        <button
          type="button"
          contenteditable="false"
          :aria-expanded="isOpen"
          :aria-controls="bodyId"
          :aria-label="toggleLabel"
          class="flex shrink-0 cursor-pointer items-center rounded focus-visible:outline-2 focus-visible:outline-primary"
          data-test="details-toggle"
          @click="toggleShownOpen"
        >
          <UIcon name="i-lucide-chevron-right" class="size-4 transition-transform group-open:rotate-90" />
        </button>
      </template>
      <template #summary>
        <!-- Takes the look of the slot it stands in. -->
        <input
          :value="node.attrs.summary ?? ''"
          placeholder="Details summary…"
          aria-label="Details summary"
          contenteditable="false"
          class="block w-full border-0 bg-transparent p-0 [font:inherit] [letter-spacing:inherit] [text-transform:inherit] [color:inherit] focus:outline-none focus:ring-0"
          @input="storeSummaryText"
        >
      </template>
      <NodeViewContent :id="bodyId" class="okb-prose-compact" />
    </CustomDetails>
    <ComponentSettingsMenu
      v-if="inViewport"
      :declaration="declaration"
      :menu-props="menuProps"
      :values="values"
      :controls="controls"
      @change="(name: string, value: unknown) => updateAttributes({ [name]: value })"
    />
  </NodeViewWrapper>
</template>
