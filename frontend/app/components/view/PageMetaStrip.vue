<script setup lang="ts">
// Top meta crumb row: document-type pill · last-updated · .md link + copy.
//
// Every value is a real field on the node, exposed by
// custom_elements.entity_ce_display.node.kb_page.full: `docType` is the
// page's `type` prop (field_type), `changed` is the node's own timestamp. The moderation state
// deliberately does not appear here — the workflow badge and its transitions
// are one control (OKB-84), not a second status pill.
import { absoluteDate, changedToMs, docTypeLabel, lastUpdatedLabel } from '#shared/utils/kb-meta'

const props = defineProps<{
  docType?: string
  changed?: string | number
  rawHref?: string
}>()

const typeLabel = computed(() => docTypeLabel(props.docType))
const changedMs = computed(() => changedToMs(props.changed))

// The instant the label is measured against. Shared with the server render
// through the payload, so the hydrating client lands in the same bucket — two
// `Date.now()` calls either side of a minute boundary render different words
// and that is a hydration mismatch. Re-read and then ticked once a minute from
// mounted, past hydration, so a page left open stops claiming "just now" after
// a peer's save.
const now = useState('kb-updated-now', () => Date.now())
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  now.value = Date.now()
  timer = setInterval(() => (now.value = Date.now()), 60_000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })

const updatedLabel = computed(() => lastUpdatedLabel(changedMs.value, now.value))
const updatedTitle = computed(() => absoluteDate(changedMs.value) ?? undefined)

// The `.md` affordance is two acts on one address: follow it, or take it. Both
// sit here rather than in the page menu, which read-only sessions never get.
const { copy: copyMarkdown, copying } = useCopyMarkdown(() => props.rawHref)
</script>

<template>
  <div class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted">
    <UBadge v-if="typeLabel" color="neutral" variant="subtle" size="xs">
      {{ typeLabel }}
    </UBadge>
    <span v-if="typeLabel && updatedLabel" class="text-dimmed">·</span>
    <span v-if="updatedLabel" :title="updatedTitle">
      Last updated
      <strong class="text-toned">{{ updatedLabel }}</strong>
    </span>
    <span v-if="rawHref" class="ml-auto inline-flex items-center gap-1">
      <a
        :href="rawHref"
        class="inline-flex items-center gap-1 rounded border border-default px-1.5 py-0.5 font-mono text-[11px] text-muted hover:bg-elevated hover:text-highlighted"
        title="Raw markdown for agents"
      >
        <UIcon name="i-lucide-file-down" class="size-3" />
        .md
      </a>
      <button
        type="button"
        class="inline-flex items-center gap-1 rounded border border-default px-1.5 py-0.5 font-mono text-[11px] text-muted hover:bg-elevated hover:text-highlighted disabled:opacity-60"
        :disabled="copying"
        aria-label="Copy as Markdown"
        title="Copy as Markdown"
        data-testid="copy-as-markdown"
        @click="copyMarkdown"
      >
        <UIcon
          :name="copying ? 'i-lucide-loader-circle' : 'i-lucide-clipboard-copy'"
          :class="['size-3', copying && 'animate-spin']"
        />
        copy
      </button>
    </span>
    <!-- Trailing extras (e.g. the edit mode's frontmatter Details toggle). -->
    <slot />
  </div>
</template>
