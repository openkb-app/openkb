<script setup lang="ts">
/**
 * A page file shown in the page (`::embed{file}`), by its MIME type:
 * - HTML: a sandboxed frame, scripts on, no same origin; its document reports
 *   its height (`okb-embed:height`), the only message this frame takes, and
 *   reports it again on `okb-embed:measure`: the frame may have loaded before
 *   this listens. The page's `frame-src` keeps it on the Drupal origin
 *   (embedFrameSrcPolicy);
 * - PDF: the browser's viewer in a plain frame, which Chromium needs;
 * - anything else, or no file: the file card.
 * Drupal sends the matching headers (PageFileEmbedSubscriber).
 */
import { EMBED_MIN_HEIGHT, embedFrameHeight, embedKind, type ResolvedFile } from '#shared/utils/files'

const props = defineProps<{
  file: ResolvedFile | null
  title?: string | null
  /** Still resolving: says so instead of "not available". */
  pending?: boolean
}>()

const kind = computed(() => props.file ? embedKind(props.file.mime) : null)
const label = computed(() => kind.value === 'html' ? 'HTML embed' : 'PDF embed')
const frameTitle = computed(() => props.title || props.file?.name || label.value)

const frame = ref<HTMLIFrameElement | null>(null)
const height = ref(EMBED_MIN_HEIGHT)

function onMessage(event: MessageEvent): void {
  const value = embedFrameHeight(event, frame.value?.contentWindow, window.innerHeight)
  if (value !== null) height.value = value
}

onMounted(() => watch(kind, (value, _, onCleanup) => {
  if (value !== 'html') return
  window.addEventListener('message', onMessage)
  frame.value?.contentWindow?.postMessage({ type: 'okb-embed:measure' }, '*')
  onCleanup(() => window.removeEventListener('message', onMessage))
}, { immediate: true }))
</script>

<template>
  <figure
    v-if="file && kind"
    class="not-prose overflow-hidden rounded-lg border border-default"
    :aria-label="`${label} ${frameTitle}`"
    :data-test="`embed-${kind}`"
  >
    <figcaption class="flex items-center gap-2 border-b border-default bg-elevated/40 px-3 py-1.5 text-sm">
      <UIcon :name="kind === 'html' ? 'i-lucide-file-code' : 'i-lucide-file-text'" class="size-4 shrink-0 text-muted" aria-hidden="true" />
      <span class="shrink-0 text-muted">{{ label }}</span>
      <span class="min-w-0 flex-1 truncate font-medium">{{ frameTitle }}</span>
      <a
        :href="file.url"
        target="_blank"
        rel="noopener"
        class="shrink-0 rounded-md px-1.5 py-0.5 text-muted hover:bg-elevated hover:text-default"
        data-test="embed-open"
      >Open full</a>
      <a
        :href="file.url"
        download
        target="_blank"
        rel="noopener"
        :aria-label="`Download ${file.name}`"
        class="shrink-0 rounded-md p-1 text-muted hover:bg-elevated hover:text-default"
      >
        <UIcon name="i-lucide-download" class="block size-4" aria-hidden="true" />
      </a>
    </figcaption>
    <iframe
      v-if="kind === 'html'"
      ref="frame"
      :src="file.url"
      sandbox="allow-scripts"
      :title="frameTitle"
      loading="lazy"
      referrerpolicy="no-referrer"
      class="block w-full bg-white"
      :style="{ height: `${height}px` }"
      data-test="embed-frame"
    />
    <iframe
      v-else
      :src="file.url"
      :title="frameTitle"
      loading="lazy"
      referrerpolicy="no-referrer"
      class="block h-[70vh] w-full"
      data-test="embed-frame"
    />
  </figure>
  <AttachmentCard v-else :file="file" :description="title" :pending="pending" />
</template>
