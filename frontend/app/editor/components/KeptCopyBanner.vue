<script setup lang="ts">
/**
 * Unsaved edits this browser holds for a document the server no longer has.
 *
 * The server rebuilt the page from Drupal, so its mirror never merges in.
 * Show opens the copy as Markdown for copying back; Discard deletes it.
 */
const props = defineProps<{
  /** When the oldest unsaved edit was made (ms). */
  since: number
  /** Reads the copy as Markdown. */
  readCopy: () => Promise<string>
}>()
const emit = defineEmits<{ discard: [] }>()

const open = ref(false)
const markdown = ref('')

const sinceLabel = computed(() =>
  new Date(props.since).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }))

/** Loads the copy and opens it in the dialog. */
async function showCopy() {
  markdown.value = await props.readCopy()
  open.value = true
}

/** Closes the dialog and deletes the copy. */
function discardCopy() {
  open.value = false
  emit('discard')
}
</script>

<template>
  <UAlert
    data-testid="kept-copy-banner"
    role="status"
    class="mb-4"
    color="warning"
    variant="subtle"
    icon="i-lucide-triangle-alert"
    orientation="horizontal"
    :title="`This browser has unsaved edits from ${sinceLabel}`"
    description="They were made on an earlier copy of this page and never reached the server. They are not part of the page. Show them to copy what you need, then discard them."
    :actions="[
      { label: 'Show', color: 'warning', size: 'sm', onClick: showCopy },
      { label: 'Discard', color: 'neutral', variant: 'outline', size: 'sm', onClick: discardCopy },
    ]"
  />

  <UModal
    v-model:open="open"
    title="Unsaved edits in this browser"
    :description="`Made from ${sinceLabel} on. Read-only: copy what you need into the page.`"
    :ui="{ content: 'sm:max-w-3xl' }"
  >
    <template #body>
      <textarea
        :value="markdown"
        readonly
        aria-label="Unsaved edits as Markdown"
        data-testid="kept-copy-text"
        class="h-[60vh] w-full resize-none rounded-md border border-default bg-elevated p-3 font-mono text-sm"
      />
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" @click="open = false">
          Close
        </UButton>
        <UButton color="error" icon="i-lucide-trash-2" data-testid="kept-copy-discard-dialog" @click="discardCopy">
          Discard
        </UButton>
      </div>
    </template>
  </UModal>
</template>
