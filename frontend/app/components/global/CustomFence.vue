<script setup lang="ts">
/**
 * A fence component's frame (shared/utils/fences.ts), the same on the read
 * page, in a chat answer and in the editor: the drawing, its error as text,
 * and the source behind a "Show source" toggle.
 *
 * The editor passes its node view wrapper as `wrapper` and the editable code
 * as the `source` slot, so pressing Edit swaps nothing that has a size
 * (docs/adr/0022).
 */
import { computed, ref, useId, watch, type Component } from 'vue'
import { fenceComponents } from '#okb-fence-components'
import type { CodeLine } from '#shared/utils/code-highlight'
import { describeFenceError, fenceFor, type FenceError } from '#shared/utils/fences'

const props = defineProps<{
  /** The fence's language. */
  fence: string
  source: string
  /** The source's token lines, for the show-source view. */
  lines?: CodeLine[]
  /** What the fence's `server.ts` rendered. */
  html?: string
  /** Why the server rendered nothing. The editor's preview draws anyway. */
  error?: FenceError
  /** A fence still streaming: shows the source only. */
  pending?: boolean
  /** The editor: redraws on every change. */
  preview?: boolean
  /** The root element; the editor's node view wrapper. */
  wrapper?: Component | string
}>()

const emit = defineEmits<{
  /** The current source's error, or null once it draws. */
  error: [error: FenceError | null]
  /** "Show source" / "Hide source" was pressed. */
  toggle: [open: boolean]
}>()

/** Whether the source shows. A fence that does not draw shows it. */
const open = defineModel<boolean>('open', { default: false })
if (props.error) open.value = true

const definition = computed(() => fenceFor(props.fence))
const drawer = computed(() => fenceComponents[props.fence])
const failure = ref<FenceError | null>(props.error ?? null)
const sourceId = useId()

const empty = computed(() => props.source.trim() === '')
const sourceLines = computed(() => props.lines ?? props.source.split('\n').map(line => (line === '' ? [] : [{ content: line }])))
const message = computed(() => failure.value
  ? `This ${definition.value?.label.toLowerCase() ?? 'block'} could not be drawn. ${describeFenceError(failure.value)}`
  : '')

/**
 * The client's draw is done (`data-drawn`); a server error mounts no drawer
 * outside the editor.
 */
const drawn = ref(Boolean(props.error && !props.preview))

/** A source that does not draw opens on the first draw only; later edits keep the reader's choice. */
function report(next: FenceError | null): void {
  failure.value = next
  if (next && !drawn.value) open.value = true
  drawn.value = true
  emit('error', next)
}

function toggle(): void {
  // A v-model's ref reads the parent's value until it re-renders.
  const next = !open.value
  open.value = next
  emit('toggle', next)
}

watch(empty, (now) => {
  if (now) report(null)
}, { immediate: true })
</script>

<template>
  <component
    :is="wrapper ?? 'figure'"
    class="okb-fence"
    :data-fence="fence"
    :data-state="pending ? 'pending' : failure ? 'error' : 'ok'"
    :data-drawn="drawn || undefined"
  >
    <CustomCodeBlock
      v-if="pending"
      :language="fence"
      :lines="sourceLines"
    />
    <template v-else>
      <p
        v-if="preview && empty"
        class="okb-fence-hint"
        contenteditable="false"
      >
        Write {{ definition?.languageLabel }} in the source to see the {{ definition?.label.toLowerCase() }}.
      </p>
      <component
        :is="drawer"
        v-else-if="drawer && (preview || !error)"
        :contenteditable="preview ? 'false' : undefined"
        :source="source"
        :html="html"
        :preview="preview"
        @error="report"
      />
      <!-- `role="status"`, no `aria-live`: a Reka popup keeps every `[aria-live]` exposed
           by aria-hiding its siblings, and in the editor those are ProseMirror's blocks. -->
      <p
        class="okb-fence-error"
        role="status"
        :contenteditable="preview ? 'false' : undefined"
      >
        <UIcon
          v-if="message"
          name="i-lucide-triangle-alert"
          class="okb-fence-error-icon"
          aria-hidden="true"
        />{{ message }}
      </p>
      <!-- In the editor a click on the toggle leaves the caret where it is. -->
      <button
        type="button"
        class="okb-fence-toggle"
        :contenteditable="preview ? 'false' : undefined"
        :aria-expanded="open"
        :aria-controls="sourceId"
        @mousedown="preview && $event.preventDefault()"
        @click="toggle"
      >
        <UIcon
          :name="open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
          class="size-4"
          aria-hidden="true"
        />
        {{ open ? 'Hide source' : 'Show source' }}
      </button>
      <div
        v-show="open"
        :id="sourceId"
      >
        <slot name="source">
          <CustomCodeBlock
            :language="fence"
            :lines="sourceLines"
          />
        </slot>
      </div>
    </template>
  </component>
</template>
