<script setup lang="ts">
/**
 * The page's files below the editor (ADR 0020), as file cards like the read
 * page's list: every file in `field_kb_attachments` and `field_kb_images`,
 * once, with a remove button. Removing takes the file and its embeds off the
 * page, out of both fields; the next checkpoint writes them.
 * An attachment has a "Show in attachments" checkbox: whether the read page
 * lists it.
 */
import { PAGE_FILE_KEYS } from '#shared/utils/page-files'
import type { EditorPageFiles } from '~/composables/useEditorPageFiles'

const { files } = defineProps<{ files: EditorPageFiles }>()

const entries = computed(() => [...new Set(PAGE_FILE_KEYS.flatMap(key => files.lists.value[key]))])

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
          <template #actions>
            <UCheckbox
              v-if="files.lists.value.attachments.includes(uuid)"
              :model-value="!files.hidden.value.includes(uuid)"
              class="shrink-0"
              data-test="page-file-display"
              @update:model-value="value => files.setHidden(uuid, !value)"
            >
              <template #label>
                Show in attachments<span class="sr-only"> {{ files.resolved.value[uuid]?.name ?? 'file' }}</span>
              </template>
            </UCheckbox>
            <UButton
              icon="i-lucide-trash-2"
              color="neutral"
              variant="ghost"
              size="sm"
              :aria-label="`Remove ${files.resolved.value[uuid]?.name ?? 'file'} from the page`"
              @click="files.remove(uuid)"
            />
          </template>
        </AttachmentCard>
      </li>
    </ul>
  </section>
</template>
