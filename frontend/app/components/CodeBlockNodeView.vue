<script setup lang="ts">
/**
 * The editor's code block: the read view's tools row with a language picker
 * in place of the label, over the editable code. The colours are the
 * decorations of `app/editor/code-highlight.ts`.
 *
 * A fence component's block (shared/utils/fences.ts) is the read view's
 * frame around the editable source, so pressing Edit changes no size
 * (docs/adr/0022). Until its first draw it shows the read view's render.
 * The source opens from "Show source" or when the user moves the caret into
 * it; the drawing follows it live. A refused source does not block the
 * save: the frame names the error and `app/editor/fence-error.ts` marks its
 * line.
 */
import { NodeViewContent, NodeViewWrapper } from '@tiptap/vue-3'
import type { NodeViewProps } from '@tiptap/vue-3'
import { Selection, type Transaction } from '@tiptap/pm/state'
import { ySyncPluginKey } from '@tiptap/y-tiptap'
import { CODE_LANGUAGES, codeLanguage } from '#shared/utils/code-languages'
import { fenceFor, type FenceError } from '#shared/utils/fences'
import { fenceErrorKey, type FenceErrorMeta } from '~/editor/fence-error'
import { readFencesKey } from '~/editor/fence-renders'

const props = defineProps<NodeViewProps>()

/** Reka's select takes no empty value, so "no language" has a name of its own. */
const PLAIN = 'plain'

const stored = computed(() => String(props.node.attrs.language ?? ''))

/** A known language by its id, whatever alias the fence spells it with. */
const value = computed(() => (stored.value === '' ? PLAIN : codeLanguage(stored.value)?.id ?? stored.value))

/** An info string outside the set stays selectable, so opening the picker does not lose it. */
const items = computed(() => [
  { label: 'Plain text', value: PLAIN },
  ...CODE_LANGUAGES.map(lang => ({ label: lang.label, value: lang.id })),
  ...(stored.value !== '' && !codeLanguage(stored.value) ? [{ label: stored.value, value: stored.value }] : []),
])

function choose(next: string): void {
  if (next === value.value) return
  const language = next === PLAIN ? null : next
  const rebuilt = fenceFor(language)?.language !== fence.value?.language
  // Into a fence component the view is rebuilt; the new one keeps the source open.
  if (fenceFor(language) && blockId.value) openFences.add(blockId.value)
  const pos = props.getPos()
  const editor = props.editor
  props.updateAttributes({ language })
  // The rebuild detaches the picker the popup returns focus to.
  if (rebuilt && typeof pos === 'number') requestAnimationFrame(() => editor.chain().focus().setTextSelection(pos + 1).run())
}

const fence = computed(() => fenceFor(stored.value))
const source = computed(() => props.node.textContent)

/** The read view's render of this block, while the source is still the one it rendered. */
const read = (() => {
  const found = inject(readFencesKey, null)?.().get(String(props.HTMLAttributes.id ?? ''))
  return found && found.source === source.value ? found : undefined
})()

const blockId = computed(() => String(props.HTMLAttributes.id ?? ''))
const openFences: Set<string> = props.extension.storage.openFences
const open = ref(openFences.has(blockId.value))
watch([open, blockId], ([now, id]) => {
  if (id) openFences[now ? 'add' : 'delete'](id)
})

function caretInside(): boolean {
  const pos = props.getPos()
  const { from } = props.editor.state.selection
  return typeof pos === 'number' && from > pos && from < pos + props.node.nodeSize
}

/** A peer's or the collab sync's selection change is not the user's. */
function openOnCaret({ transaction }: { transaction: Transaction }): void {
  if (fence.value && !transaction.getMeta(ySyncPluginKey) && caretInside()) open.value = true
}

/**
 * "Show source" takes the caret into the source, so the keyboard can edit it.
 * "Hide source" takes it out, so no keystroke edits hidden text.
 */
function onToggle(now: boolean): void {
  const pos = props.getPos()
  if (typeof pos !== 'number') return
  if (now && !caretInside()) props.editor.chain().focus().setTextSelection(pos + 1).run()
  if (!now && caretInside()) {
    const { doc } = props.editor.state
    const out = Selection.findFrom(doc.resolve(pos + props.node.nodeSize), 1, true) ?? Selection.findFrom(doc.resolve(pos), -1, true)
    if (out) props.editor.view.dispatch(props.editor.state.tr.setSelection(out))
    else props.editor.commands.blur()
  }
}

onMounted(() => props.editor.on('selectionUpdate', openOnCaret))
onBeforeUnmount(() => props.editor.off('selectionUpdate', openOnCaret))

/**
 * Every render reports; only a changed line or line text is dispatched.
 * Text typed at the line's end falls outside the mapped mark, so it re-marks.
 */
let marked = ''

function markLine(error: FenceError | null): void {
  const line = error?.line ?? 0
  const key = line ? `${line}:${source.value.split('\n')[line - 1] ?? ''}` : ''
  const pos = props.getPos()
  if (key === marked || typeof pos !== 'number' || props.editor.isDestroyed) return
  marked = key
  const meta: FenceErrorMeta = { pos, line }
  props.editor.view.dispatch(props.editor.state.tr.setMeta(fenceErrorKey, meta))
}
</script>

<template>
  <CustomFence
    v-if="fence"
    :id="props.HTMLAttributes.id"
    v-model:open="open"
    :wrapper="NodeViewWrapper"
    as="figure"
    :fence="fence.language"
    :source="source"
    :html="read?.html"
    :error="read?.error"
    preview
    @error="markLine"
    @toggle="onToggle"
  >
    <template #source>
      <pre class="okb-code"><span
        class="okb-code-tools"
        contenteditable="false"
      ><USelect
        :model-value="value"
        :items="items"
        value-key="value"
        size="xs"
        variant="ghost"
        aria-label="Code language"
        class="okb-code-lang"
        :ui="{ content: 'min-w-40' }"
        @update:model-value="choose"
      /></span><NodeViewContent
        as="code"
        :class="`language-${value}`"
      /></pre>
    </template>
  </CustomFence>
  <NodeViewWrapper
    v-else
    as="pre"
    class="okb-code"
    :id="props.HTMLAttributes.id"
  >
    <span
      class="okb-code-tools"
      contenteditable="false"
    >
      <USelect
        :model-value="value"
        :items="items"
        value-key="value"
        size="xs"
        variant="ghost"
        aria-label="Code language"
        class="okb-code-lang"
        :ui="{ content: 'min-w-40' }"
        @update:model-value="choose"
      />
    </span>
    <NodeViewContent
      as="code"
      :class="value === PLAIN ? undefined : `language-${value}`"
    />
  </NodeViewWrapper>
</template>
