<script setup lang="ts">
/**
 * The page's files below the editor (ADR 0020), as file cards like the read
 * page's list: every file in `field_kb_attachments` and `field_kb_images`,
 * each with a remove button. Removing takes the file and its embeds off the
 * page; the next checkpoint writes the field.
 */
import { fileUploaded } from '#shared/utils/files'
import { PAGE_FILE_KEYS } from '#shared/utils/page-files'
import type { EditorPageFiles } from '~/composables/useEditorPageFiles'

const { files } = defineProps<{ files: EditorPageFiles }>()

const entries = computed(() => PAGE_FILE_KEYS.flatMap(key => files.lists.value[key].map(uuid => ({ key, uuid }))))
</script>

<template>
  <section v-if="entries.length" aria-labelledby="page-files-heading" class="mt-10 max-w-[720px]" data-field="files">
    <h2 id="page-files-heading" class="mb-3 text-sm font-semibold text-highlighted">
      Attachments
    </h2>
    <ul class="flex flex-col gap-2">
      <li v-for="entry in entries" :key="`${entry.key}:${entry.uuid}`" :data-file="entry.uuid">
        <AttachmentCard
          :file="files.resolved.value[entry.uuid] ?? null"
          :description="files.descriptions.value[entry.uuid] ?? null"
          :detail="files.resolved.value[entry.uuid] ? fileUploaded(files.resolved.value[entry.uuid]!) : null"
          :pending="!files.settled.value"
        >
          <template #actions>
            <UButton
              icon="i-lucide-trash-2"
              color="neutral"
              variant="ghost"
              size="sm"
              :aria-label="`Remove ${files.resolved.value[entry.uuid]?.name ?? 'file'} from the page`"
              @click="files.remove(entry.key, entry.uuid)"
            />
          </template>
        </AttachmentCard>
      </li>
    </ul>
  </section>
</template>
