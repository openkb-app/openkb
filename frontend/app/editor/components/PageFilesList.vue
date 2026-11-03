<script setup lang="ts">
/**
 * The page's files below the editor (ADR 0020), as file cards like the read
 * page's list: every file in `field_kb_attachments` and `field_kb_images`,
 * once, with a remove button. Removing takes the file and its embeds off the
 * page, out of both fields; the next checkpoint writes them.
 * - The edit button opens the name and description in place:
 *   - the name is the file's name on this page; empty shows the file's own;
 *   - the description, for a file with an `::attachment` card, is written into
 *     every card of the file.
 * - An attachment has a "Show in attachments" checkbox: whether the read page
 *   lists it.
 */
import { FILE_NAME_MAX_LENGTH, PAGE_FILE_KEYS } from '#shared/utils/page-files'
import type { EditorPageFiles } from '~/composables/useEditorPageFiles'

const { files } = defineProps<{ files: EditorPageFiles }>()

const entries = computed(() => [...new Set(PAGE_FILE_KEYS.flatMap(key => files.lists.value[key]))])

const shownName = (uuid: string) => files.resolved.value[uuid]?.name ?? 'file'
const ownName = (uuid: string) => files.fileNames.value[uuid] ?? files.resolved.value[uuid]?.name ?? ''

const editing = ref<string | null>(null)

function rename(uuid: string, event: Event): void {
  const input = event.target as HTMLInputElement
  files.rename(uuid, input.value)
  // An empty name shows the file's own again.
  input.value = shownName(uuid)
}

const INPUT = 'block w-full rounded-sm bg-default px-1.5 -mx-1.5 my-0.5 ring-1 ring-inset ring-accented outline-none placeholder:text-dimmed focus:text-default focus-visible:ring-2 focus-visible:ring-primary'
</script>

<template>
  <section v-if="entries.length" aria-labelledby="page-files-heading" class="mt-10 max-w-[720px]" data-field="files">
    <h2 id="page-files-heading" class="mb-3 text-sm font-semibold text-highlighted">
      Attachments
    </h2>
    <ul class="flex flex-col gap-2">
      <li v-for="uuid in entries" :key="uuid" :data-file="uuid">
        <AttachmentCard
          :file="files.resolved.value[uuid] ?? null"
          :description="files.descriptions.value[uuid] ?? null"
          uploaded
          :pending="!files.settled.value"
        >
          <template v-if="editing === uuid" #name>
            <input
              :value="files.resolved.value[uuid]?.name"
              :placeholder="ownName(uuid)"
              :maxlength="FILE_NAME_MAX_LENGTH"
              :aria-label="`Name of ${shownName(uuid)} on this page`"
              :class="[INPUT, 'font-medium']"
              data-test="page-file-name"
              @change="rename(uuid, $event)"
              @keydown.esc.prevent="editing = null"
            >
          </template>
          <template v-if="editing === uuid && files.carded.value.includes(uuid)" #description>
            <input
              :value="files.descriptions.value[uuid] ?? ''"
              placeholder="Add a description"
              :aria-label="`Description of ${shownName(uuid)}`"
              :class="[INPUT, 'text-sm text-muted']"
              data-test="page-file-description"
              @change="files.describe(uuid, ($event.target as HTMLInputElement).value)"
              @keydown.esc.prevent="editing = null"
            >
          </template>
          <template #actions>
            <UButton
              :icon="editing === uuid ? 'i-lucide-check' : 'i-lucide-pencil'"
              color="neutral"
              variant="ghost"
              size="sm"
              :aria-label="editing === uuid ? `Done editing ${shownName(uuid)}` : `Edit name and description of ${shownName(uuid)}`"
              :aria-expanded="editing === uuid"
              data-test="page-file-edit"
              @click="editing = editing === uuid ? null : uuid"
            />
            <UCheckbox
              v-if="files.lists.value.attachments.includes(uuid)"
              label="Show in attachments"
              :aria-label="`Show in attachments ${shownName(uuid)}`"
              :model-value="!files.hidden.value.includes(uuid)"
              class="shrink-0"
              data-test="page-file-display"
              @update:model-value="value => files.setHidden(uuid, !value)"
            />
            <UButton
              icon="i-lucide-trash-2"
              color="neutral"
              variant="ghost"
              size="sm"
              :aria-label="`Remove ${shownName(uuid)} from the page`"
              @click="files.remove(uuid)"
            />
          </template>
        </AttachmentCard>
      </li>
    </ul>
  </section>
</template>
