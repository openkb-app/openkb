<script setup lang="ts">
// Top meta crumb row: document-type pill · last-updated · .md link + copy.
//
// Every value is a real field on the node, exposed by
// custom_elements.entity_ce_display.node.kb_page.full: `docType` is the
// page's `type` prop (field_type), `changed` is the node's own timestamp. The moderation state
// deliberately does not appear here — the workflow badge and its transitions
// are one control (OKB-84), not a second status pill.
//
// The Vue imports are explicit, not auto-imported: the component is rendered
// by its own vitest suite outside a Nuxt app.
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { absoluteDate, changedToMs, docTypeLabel, lastUpdatedLabel } from '#shared/utils/kb-meta'

const props = defineProps<{
  docType?: string
  changed?: string | number
  rawHref?: string
  /**
   * The working copy's markdown, serialized on demand. Set in edit mode, where
   * the reader expects the document being edited: the published `.md` has no
   * address for it, so the link is left out and the copy reads this instead.
   */
  workingCopy?: () => string
  /**
   * Whether the values shown here are editable — set in edit mode, where the
   * Details form owns them and the pill is the way into it.
   */
  editable?: boolean
}>()

const emit = defineEmits<{
  /** Edit one frontmatter field, by its key. Only fired while `editable`. */
  editField: [key: string]
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
const { copy: copyPublished, copying } = useCopyMarkdown(() => props.rawHref)
const { copy: copyPlain } = useCopyText()

const copyLabel = computed(() =>
  props.workingCopy ? 'Copy the working copy as Markdown' : 'Copy as Markdown',
)

function copyMarkdown() {
  if (props.workingCopy) return copyPlain(props.workingCopy(), 'Working copy')
  return copyPublished()
}
</script>

<template>
  <div class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted">
    <UBadge
      v-if="typeLabel"
      :as="editable ? 'button' : 'span'"
      :type="editable ? 'button' : undefined"
      color="neutral"
      variant="subtle"
      size="sm"
      :class="editable ? 'cursor-pointer hover:bg-accented focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary' : undefined"
      :aria-label="editable ? `Edit the page type: ${typeLabel}` : undefined"
      data-testid="page-type-pill"
      @click="editable && emit('editField', 'type')"
    >
      {{ typeLabel }}
    </UBadge>
    <span v-if="typeLabel && updatedLabel" class="text-dimmed">·</span>
    <span v-if="updatedLabel" :title="updatedTitle">
      Last updated
      <strong class="text-toned">{{ updatedLabel }}</strong>
    </span>
    <span v-if="rawHref || workingCopy" class="ml-auto inline-flex items-center gap-1">
      <a
        v-if="rawHref && !workingCopy"
        :href="rawHref"
        class="inline-flex items-center gap-1 rounded border border-default px-1.5 py-1 font-mono text-[12px] text-muted hover:bg-elevated hover:text-highlighted"
        title="Raw markdown for agents"
      >
        <UIcon name="i-lucide-file-down" class="size-3.5" />
        .md
      </a>
      <button
        type="button"
        class="inline-flex items-center gap-1 rounded border border-default px-1.5 py-1 font-mono text-[12px] text-muted hover:bg-elevated hover:text-highlighted disabled:opacity-60"
        :disabled="copying"
        :aria-label="copyLabel"
        :title="copyLabel"
        data-testid="copy-as-markdown"
        @click="copyMarkdown"
      >
        <UIcon
          :name="copying ? 'i-lucide-loader-circle' : 'i-lucide-clipboard-copy'"
          :class="['size-3.5', copying && 'animate-spin']"
        />
        copy
      </button>
    </span>
    <!-- Trailing extras (e.g. the edit mode's frontmatter Details toggle). -->
    <slot />
  </div>
</template>
