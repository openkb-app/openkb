<script setup lang="ts">
/**
 * The image and file picker, laid out like a media library:
 * - an upload dropzone on top; a cancelled file dialog leaves the picker open;
 * - this page's files, each with a Select button, in a scroll area;
 * - "my files": the caller's own uploads, newest first, in a `UCommandPalette`,
 *   so the filter and the keyboard are the palette's. The modal body scrolls
 *   it: the palette's own scroller holds nothing tabbable.
 * Choosing puts the file on the page; Escape leaves the page as it was.
 */
import { closeFilePicker, pageFileLimits, useFilePickerStatus, type FilePickerChoice } from '~/editor/page-file-insert'
import { nameListbox } from '~/editor/name-listbox'
import { fileAccept, fileIcon, formatFileSize, type MyFile } from '#shared/utils/files'
import type { EditorPageFiles } from '~/composables/useEditorPageFiles'

const props = defineProps<{ token: number, images: boolean, files: EditorPageFiles }>()

const { data, status, error } = useFetch<{ items: MyFile[] }>('/api/files/mine', {
  query: props.images ? { images: 1 } : {},
  key: `okb-my-files-${props.images ? 'images' : 'all'}`,
  server: false,
})
const { data: limits } = useAsyncData(
  `okb-file-limits-${props.images ? 'images' : 'attachments'}`,
  () => pageFileLimits(props.images ? 'images' : 'attachments'),
  { server: false },
)
const title = computed(() => props.images ? 'Insert image' : 'Insert file')
const mineTitle = computed(() => props.images ? 'My images' : 'My files')

const onPage = computed(() => props.files.lists.value[props.images ? 'images' : 'attachments'].flatMap((id) => {
  const file = props.files.resolved.value[id]
  return file ? [{ id, ...file }] : []
}))

const groups = computed(() => [{
  id: 'files',
  items: (data.value?.items ?? []).map(file => ({
    label: file.name,
    description: file.usedOn.length ? `On ${file.usedOn.join(', ')}` : undefined,
    suffix: formatFileSize(file.size),
    icon: fileIcon(file.mime),
    onSelect: () => close(file),
  })),
}])
const nameFilesListbox = nameListbox(props.images ? 'Your images' : 'Your files')

const announcement = useFilePickerStatus()
watchEffect(() => {
  announcement.value = listStatus()
})
function listStatus(): string {
  if (error.value) return ''
  if (status.value === 'pending') return 'Loading your files…'
  const count = data.value?.items.length ?? 0
  return count === 0 ? 'No files to choose from.' : `${count} ${count === 1 ? 'file' : 'files'} to choose from.`
}
onBeforeUnmount(() => { announcement.value = '' })

// Focus starts on the upload dropzone, the first choice.
function focusUpload(event: Event): void {
  const dropzone = (event.target as HTMLElement | null)?.querySelector<HTMLElement>('[data-slot="base"][role="button"]')
  if (!dropzone) return
  event.preventDefault()
  dropzone.focus()
}

function close(choice: FilePickerChoice | null): void {
  closeFilePicker(props.token, choice)
}
</script>

<template>
  <UModal
    :open="true"
    :title="title"
    description="Upload a new one, or choose one this page or you already have."
    :content="{ onOpenAutoFocus: focusUpload }"
    @update:open="open => { if (!open) close(null) }"
  >
    <template #body>
      <div class="flex flex-col gap-5">
        <UFileUpload
          :accept="fileAccept(limits ?? undefined)"
          multiple
          :icon="images ? 'i-lucide-image-up' : 'i-lucide-upload'"
          :label="images ? 'Upload a new image' : 'Upload a new file'"
          description="Click or drop files here"
          class="w-full min-h-32"
          @update:model-value="files => files?.length && close({ upload: [...files] })"
        />

        <section v-if="onPage.length" aria-labelledby="file-picker-page-heading">
          <h3 id="file-picker-page-heading" class="mb-2 text-sm font-semibold text-highlighted">
            On this page
          </h3>
          <ul class="max-h-48 divide-y divide-default overflow-y-auto rounded-md border border-default" data-test="file-picker-page">
            <li v-for="file in onPage" :key="file.id" class="flex items-center gap-3 px-3 py-2">
              <img v-if="images" :src="file.url" alt="" class="size-10 shrink-0 rounded object-cover">
              <UIcon v-else :name="fileIcon(file.mime)" class="size-5 shrink-0 text-muted" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate text-sm">{{ file.name }}</span>
              <UButton
                label="Select"
                size="xs"
                color="neutral"
                variant="outline"
                :aria-label="`Select ${file.name}`"
                @click="close(file)"
              />
            </li>
          </ul>
        </section>

        <section aria-labelledby="file-picker-mine-heading">
          <h3 id="file-picker-mine-heading" class="mb-2 text-sm font-semibold text-highlighted">
            {{ mineTitle }}
          </h3>
          <UCommandPalette
            :ref="nameFilesListbox"
            :groups="groups"
            :loading="status === 'pending'"
            :fuse="{ fuseOptions: { keys: ['label'] }, resultLimit: 200 }"
            :input="{ 'aria-label': 'Filter your files by name' }"
            :autofocus="false"
            placeholder="Filter by name"
            class="rounded-md border border-default"
            data-test="my-files"
          >
            <template #empty>
              <p v-if="error" class="p-2 text-sm text-error" role="alert">
                Your files could not be loaded. Close this dialog and try again.
              </p>
              <p v-else class="p-2 text-sm text-muted" aria-hidden="true">
                {{ status === 'pending' ? 'Loading your files…' : 'No files to choose from.' }}
              </p>
            </template>
          </UCommandPalette>
        </section>
      </div>
    </template>
  </UModal>
</template>
