<script setup lang="ts">
/**
 * The embed bubble's Rename: the button opens the file's name on this page in
 * place, the same name the attachment list edits. Leaving the field renames;
 * Enter renames and Escape keeps the name, both return to the text.
 */
import type { Editor } from '@tiptap/core'
import { FILE_NAME_MAX_LENGTH } from '#shared/utils/page-files'
import type { EditorPageFiles } from '~/composables/useEditorPageFiles'

const { files, uuid, editor } = defineProps<{ files: EditorPageFiles, uuid: string, editor: Editor }>()

const shown = computed(() => files.resolved.value[uuid]?.name ?? 'file')
const ownName = computed(() => files.fileNames.value[uuid] ?? shown.value)

const editing = ref(false)
const input = useTemplateRef('input')

/** Opens the name field with the name selected. */
async function openNameField(): Promise<void> {
  editing.value = true
  await nextTick()
  input.value?.inputRef?.focus()
  input.value?.inputRef?.select()
}

/** Closes the name field and returns to the text. */
function closeNameField(): void {
  editing.value = false
  editor.view.focus()
}

/** Enter closes the field, except while an IME composes. */
function onEnter(event: KeyboardEvent): void {
  if (event.isComposing) return
  event.preventDefault()
  closeNameField()
}

/** Puts the shown name back into the field, so leaving it renames nothing, and closes it. */
function discardNameField(event: Event): void {
  (event.target as HTMLInputElement).value = shown.value
  closeNameField()
}

/** Names the file on this page from the field. */
function renameFileFromField(event: Event): void {
  files.rename(uuid, (event.target as HTMLInputElement).value)
}
</script>

<template>
  <UInput
    v-if="editing"
    ref="input"
    :default-value="shown"
    :placeholder="ownName"
    :maxlength="FILE_NAME_MAX_LENGTH"
    size="sm"
    class="w-56"
    :aria-label="`Name of ${shown} on this page`"
    data-test="embed-file-name"
    @change="renameFileFromField"
    @blur="editing = false"
    @keydown.enter="onEnter"
    @keydown.esc.prevent="discardNameField"
  />
  <UTooltip v-else text="Rename">
    <UButton
      icon="i-lucide-pencil"
      color="neutral"
      variant="ghost"
      size="sm"
      aria-label="Rename"
      @click="openNameField"
    />
  </UTooltip>
</template>
