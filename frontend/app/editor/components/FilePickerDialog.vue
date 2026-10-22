<script setup lang="ts">
/**
 * The image and file picker, laid out like a media library:
 * - an upload dropzone on top; a cancelled file dialog leaves the picker open;
 * - this page's files, in a scroll area;
 * - "my files": the caller's newest uploads, in a `UCommandPalette`, so the
 *   filter and the keyboard are the palette's; the filter finds the older ones.
 *   The modal body scrolls it: the palette's own scroller holds nothing tabbable.
 * Both lists use `FilePickerItem`, "my files" in its compact size; clicking a row chooses it.
 * Choosing puts the file on the page; Escape leaves the page as it was.
 * An embed kind lists and accepts its file types only.
 */
import { closeFilePicker, pageFileLimits, pickEmbedKinds, pickKey, useFilePickerStatus, type FilePickKind, type FilePickerChoice } from '~/editor/page-file-insert'
import { nameListbox } from '~/editor/name-listbox'
import { embedKind, fileAccept, type MyFile, type PageFileLimits } from '#shared/utils/files'
import type { EditorPageFiles } from '~/composables/useEditorPageFiles'

const props = defineProps<{ token: number, kind: FilePickKind, multiple: boolean, files: EditorPageFiles }>()

const images = props.kind === 'image'
const key = pickKey(props.kind)
const embedKinds = pickEmbedKinds(props.kind)
function offered(file: { mime: string }): boolean {
  const kind = embedKind(file.mime)
  return !embedKinds || (kind !== null && embedKinds.includes(kind))
}

const { data, status, error } = useFetch<{ items: MyFile[] }>('/api/files/mine', {
  query: images ? { images: 1 } : {},
  key: `okb-my-files-${images ? 'images' : 'all'}`,
  server: false,
})
const { data: fieldLimits } = useAsyncData(`okb-file-limits-${key}`, () => pageFileLimits(key), { server: false })
/** An embed kind uploads its own extensions only: `html`, `pdf`. */
const limits = computed<PageFileLimits | undefined>(() => {
  const field = fieldLimits.value ?? undefined
  if (!field || !embedKinds) return field
  return { ...field, extensions: field.extensions.filter(extension => (embedKinds as string[]).includes(extension)) }
})
const TITLES: Record<FilePickKind, [string, string]> = {
  image: ['Insert image', 'My images'],
  file: ['Insert file', 'My files'],
  html: ['Insert HTML embed', 'My HTML files'],
  pdf: ['Insert PDF embed', 'My PDFs'],
  embed: ['Choose an HTML file or PDF', 'My HTML files and PDFs'],
}
const [title, mineTitle] = TITLES[props.kind]

const onPage = computed(() => props.files.lists.value[key].flatMap((id) => {
  const file = props.files.resolved.value[id]
  return file && offered(file) ? [{ id, ...file, detail: props.files.descriptions.value[id] ?? null }] : []
}))

/** Rows "my files" shows: the newest without a filter, the best matches with one. */
const MINE_SHOWN = 6
const searchTerm = ref('')
const mine = computed(() => (data.value?.items ?? []).filter(offered))
const groups = computed(() => [{
  id: 'files',
  items: (searchTerm.value ? mine.value : mine.value.slice(0, MINE_SHOWN)).map(file => ({
    label: file.name,
    file,
    detail: file.usedOn.length ? `On ${file.usedOn.join(', ')}` : null,
    onSelect: () => close(file),
  })),
}])
const mineHidden = computed(() => searchTerm.value ? 0 : Math.max(0, mine.value.length - MINE_SHOWN))
const nameFilesListbox = nameListbox(images ? 'Your images' : 'Your files')

const announcement = useFilePickerStatus()
watchEffect(() => {
  announcement.value = listStatus()
})
function listStatus(): string {
  if (error.value) return ''
  if (status.value === 'pending') return 'Loading your files…'
  const count = mine.value.length
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

/** UFileUpload answers a list, or one file without `multiple`. */
function picked(value: File[] | File | null | undefined): void {
  const files = value instanceof File ? [value] : value ?? []
  if (files.length) close({ upload: [...files] })
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
          :accept="fileAccept(limits)"
          :multiple="multiple"
          :icon="images ? 'i-lucide-image-up' : 'i-lucide-upload'"
          :label="images ? 'Upload a new image' : 'Upload a new file'"
          description="Click or drop files here"
          class="w-full min-h-32"
          @update:model-value="picked"
        />

        <section v-if="onPage.length" aria-labelledby="file-picker-page-heading">
          <h3 id="file-picker-page-heading" class="mb-2 text-sm font-semibold text-highlighted">
            On this page
          </h3>
          <ul class="max-h-48 overflow-y-auto rounded-md border border-default p-1" data-test="file-picker-page">
            <li v-for="file in onPage" :key="file.id">
              <button
                type="button"
                class="group flex w-full rounded-md p-1.5 hover:bg-elevated/50 focus-visible:bg-elevated/50 focus-visible:outline-2 focus-visible:outline-primary"
                :aria-label="`Select ${file.name}`"
                @click="close(file)"
              >
                <EditorFilePickerItem :name="file.name" :url="file.url" :mime="file.mime" :size="file.size" :detail="file.detail" />
              </button>
            </li>
          </ul>
        </section>

        <section aria-labelledby="file-picker-mine-heading">
          <h3 id="file-picker-mine-heading" class="mb-2 text-sm font-semibold text-highlighted">
            {{ mineTitle }}
          </h3>
          <UCommandPalette
            :ref="nameFilesListbox"
            v-model:search-term="searchTerm"
            :groups="groups"
            :loading="status === 'pending'"
            :fuse="{ fuseOptions: { keys: ['label'] }, resultLimit: Number.POSITIVE_INFINITY }"
            :input="{ 'aria-label': 'Filter your files by name' }"
            :autofocus="false"
            placeholder="Filter by name"
            class="rounded-md border border-default"
            data-test="my-files"
          >
            <template #item="{ item }">
              <EditorFilePickerItem :name="item.file.name" :url="item.file.url" :mime="item.file.mime" :size="item.file.size" :detail="item.detail" compact />
            </template>
            <template #empty>
              <p v-if="error" class="p-2 text-sm text-error" role="alert">
                Your files could not be loaded. Close this dialog and try again.
              </p>
              <p v-else class="p-2 text-sm text-muted" aria-hidden="true">
                {{ status === 'pending' ? 'Loading your files…' : 'No files to choose from.' }}
              </p>
            </template>
          </UCommandPalette>
          <p v-if="mineHidden" class="mt-1 text-xs text-muted">
            {{ mineHidden }} more — filter by name to find them.
          </p>
        </section>
      </div>
    </template>
  </UModal>
</template>
