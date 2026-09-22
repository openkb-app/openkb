<script setup lang="ts">
// Composer (bottom of the chat panel). Wraps UChatPrompt and exposes the
// design's bottom toolbar: attach (stub), the scope in force, send/stop. The
// scope is the picker's, read-only here — the header changes it.
import type { Chat } from '@ai-sdk/vue'
import type { UIMessage } from 'ai'

interface Props {
  // Two-way bound prompt text. Lifted to the parent so the panel can
  // reset it after submit.
  modelValue: string
  status: string
  /** The scope in force, as the pill in the header names it. */
  scope: string
  chat: Chat<UIMessage>
}

const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'submit'): void
}>()

const text = computed({
  get: () => props.modelValue,
  set: (v: string) => emit('update:modelValue', v),
})

const toast = useToast()

function attach() {
  // Stub until multipart prompts carry a file part. Same promise as the
  // editor's own Attach file.
  toast.add({
    title: 'Attachments',
    description: 'File uploads land in beta2.',
    icon: 'i-lucide-paperclip',
    color: 'info',
  })
}

function onSubmit() {
  emit('submit')
}
</script>

<template>
  <!-- `autofocus` off: the panel remounts with every page, and the chat asks
       for the caret itself when the reader opens it. -->
  <UChatPrompt
    v-model="text"
    :autofocus="false"
    placeholder="Ask anything across your spaces — answers cite the pages they came from."
    :rows="2"
    :maxrows="6"
    :ui="{ base: 'px-1.5' }"
    @submit="onSubmit"
  >
    <template #footer>
      <div class="flex w-full items-center gap-2 px-1.5 py-1">
        <button
          type="button"
          data-test="chat-attach"
          class="inline-flex h-7 w-7 items-center justify-center rounded text-(--ui-text-muted) hover:bg-(--ui-bg-muted) hover:text-(--ui-text)"
          aria-label="Attach"
          @click="attach"
        >
          <UIcon name="i-lucide-paperclip" class="size-3.5" />
        </button>

        <!-- One line whatever the space is called: the footer sits beside the
             send control and must not push it down. -->
        <span
          class="inline-flex min-w-0 items-center gap-1 text-[10.5px] text-(--ui-text-dimmed)"
          :title="`Scope: ${props.scope}`"
        >
          <UIcon name="i-lucide-database" class="size-3 shrink-0" />
          <span class="hidden shrink-0 md:inline">Scope:</span>
          <span class="max-w-[9rem] truncate text-(--ui-text-muted)">{{ scope }}</span>
        </span>

        <UChatPromptSubmit
          class="ml-auto"
          :status="status"
          color="primary"
          @stop="chat.stop()"
        />
      </div>
    </template>
  </UChatPrompt>
</template>
