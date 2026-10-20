<script setup lang="ts">
// Explicit, not auto-imported: the component is rendered by its own vitest
// suite outside a Nuxt app.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { BubbleMenu } from '@tiptap/vue-3/menus'
import { posToDOMRect } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import type { ResolvedTarget } from '~/composables/useDocLinkSearch'
import {
  BUBBLE_REQUEST_KEY,
  LINK_BUBBLE_KEY,
  bubbleTargetAt,
  clearLinkBubbleRequest,
  openHref,
  removeTarget,
  retarget,
  setCitationUrl,
  setFileLink,
  setLinkHref,
  trackLinkTarget,
  type BubbleRequest,
  type LinkTarget,
  type PageFileSource,
} from '~/editor/link-target'
import { formatFileSize } from '#shared/utils/files'
import { CITE_STATE_NOTE, citeState, citeTarget, citeUrlTitle } from '#shared/utils/citations'

/**
 * Shows where a link, page link, file link or citation points, with Open,
 * Change and Remove (editor/link-target.ts holds the model and the commands).
 * A new link can instead point at a file from the file picker.
 *
 * Shown for a caret in a link or a selected page link or citation, and on
 * request (`Mod-k`, the Link button). Tab from the editor moves into it,
 * Escape moves back with the selection unchanged. Placed below the target, so
 * the target stays clickable and the formatting bubble keeps the space above.
 */
const props = defineProps<{
  editor: Editor
  resolve: (nid: number, block: string | null) => Promise<ResolvedTarget | null>
  options?: object
  /** Whether a mouse button is held in the editor: the bubble waits for the release. */
  held?: () => boolean
  /** This page's files; without it no file can be linked. */
  files?: PageFileSource
}>()
const emit = defineEmits<{ (e: 'request'): void }>()

const KIND_NAME = { link: 'Link', docLink: 'Page link', citation: 'Citation', attachment: 'File link' } as const

const target = shallowRef<LinkTarget | null>(bubbleTargetAt(props.editor.state))
/** The resolved page of a page target; undefined while it loads. */
const resolved = ref<ResolvedTarget | null | undefined>(undefined)
const editing = ref(false)
/** The file picker is open for the target. */
const picking = ref(false)
const url = ref('')
const invalid = ref(false)
const panel = ref<HTMLElement | null>(null)
const field = ref<{ inputRef?: HTMLInputElement } | null>(null)

/** The page file a file link names, if this page has it. */
const linkedFile = computed(() => {
  const value = target.value
  if (value?.kind !== 'attachment') return null
  return props.files?.list().find(file => file.uuid === value.attrs.file) ?? null
})

/** The page a page target names; null for a link, a file link or a URL citation. */
const page = computed(() => {
  const value = target.value
  if (!value || value.kind === 'link' || value.kind === 'attachment' || (value.kind === 'citation' && value.attrs.url)) return null
  return value.attrs.nid ? { nid: Number(value.attrs.nid), block: value.attrs.block } : null
})

watch(() => page.value && `${page.value.nid}#${page.value.block ?? ''}`, async (key) => {
  resolved.value = undefined
  if (!key || !page.value) return
  const found = await props.resolve(page.value.nid, page.value.block)
  if (key === (page.value && `${page.value.nid}#${page.value.block ?? ''}`)) resolved.value = found
}, { immediate: true })

const isNewLink = computed(() => target.value?.kind === 'link' && !target.value.attrs.href)
const href = computed(() => {
  if (!target.value) return ''
  return openHref(target.value, target.value.kind === 'attachment' ? linkedFile.value?.url ?? null : resolved.value?.path || null)
})

/** What the bubble says about the target: a heading, a detail line, and a note. */
const shown = computed(() => {
  const value = target.value
  if (!value) return null
  if (value.kind === 'link') return { heading: value.attrs.href, detail: '', blockLabel: '', note: '' }
  if (value.kind === 'attachment') {
    const file = linkedFile.value
    return file
      ? { heading: file.name, detail: formatFileSize(file.size), blockLabel: '', note: '' }
      : { heading: 'File not available', detail: '', blockLabel: '', note: '' }
  }
  if (value.kind === 'citation' && value.attrs.url) {
    return { heading: citeUrlTitle(value.attrs.url), detail: value.attrs.url, blockLabel: '', note: '' }
  }
  if (!page.value || resolved.value === null) {
    return { heading: 'Page not found or not accessible', detail: href.value, blockLabel: '', note: '' }
  }
  if (resolved.value === undefined) return { heading: 'Loading…', detail: '', blockLabel: '', note: '' }
  const cited = value.kind === 'citation' ? citeTarget(value.attrs as Record<string, unknown>) : null
  const state = cited ? citeState(cited, resolved.value.versions) : 'ok'
  return {
    heading: resolved.value.title || href.value,
    detail: resolved.value.path,
    blockLabel: resolved.value.blockLabel ?? '',
    note: state === 'ok' ? '' : CITE_STATE_NOTE[state],
  }
})

/**
 * Whether `next` is still `prev`: same kind, same attrs. Not by position: a
 * co-editor's change arrives as a replacement of the whole document.
 */
function sameTarget(next: LinkTarget | null, prev: LinkTarget | null): boolean {
  return !!next && !!prev && next.kind === prev.kind && JSON.stringify(next.attrs) === JSON.stringify(prev.attrs)
}

function focusFirst(): void {
  panel.value?.querySelector<HTMLElement>('button, input, [href]:not([tabindex="-1"])')?.focus()
}

function startEdit(): void {
  const value = target.value
  if (!value) return
  url.value = value.kind === 'link' ? value.attrs.href : value.kind === 'citation' ? value.attrs.url ?? '' : ''
  invalid.value = false
  editing.value = true
  nextTick(() => field.value?.inputRef?.focus())
}

/** Links the target to the file the picker gives, wherever the target moved meanwhile. */
async function pickFile(): Promise<void> {
  if (!props.files || !target.value || picking.value) return
  editing.value = false
  const tracked = trackLinkTarget(props.editor, target.value)
  picking.value = true
  try {
    await props.files.pick((uuid) => {
      const current = tracked.current()
      return !!current && !props.editor.isDestroyed && setFileLink(props.editor, current, uuid)
    })
  }
  finally {
    tracked.stop()
    picking.value = false
  }
}

/** Back to the text, selection unchanged. A new link that was never applied is dropped. */
function close(): void {
  editing.value = false
  clearLinkBubbleRequest(props.editor)
  props.editor.view.focus()
}

function apply(): void {
  const value = target.value
  if (!value) return
  const done = value.kind === 'link' ? setLinkHref(props.editor, value, url.value) : setCitationUrl(props.editor, value, url.value)
  invalid.value = !done
  if (done) {
    editing.value = false
    clearLinkBubbleRequest(props.editor)
  }
}

function change(): void {
  const value = target.value
  if (!value) return
  if (value.kind === 'docLink' || value.kind === 'attachment' || (value.kind === 'citation' && !value.attrs.url)) retarget(props.editor, value)
  else startEdit()
}

function remove(): void {
  if (target.value) removeTarget(props.editor, target.value, linkedFile.value?.name)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  close()
}

function isVisible(): boolean {
  return !!panel.value && getComputedStyle(panel.value).visibility !== 'hidden'
}

/** Tab from the editor moves into the bubble while it shows. */
function tabIn(event: KeyboardEvent): void {
  if (event.key !== 'Tab' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
  if (!target.value || !isVisible()) return
  event.preventDefault()
  focusFirst()
}

function onTransaction({ transaction }: { transaction: Transaction }): void {
  const next = bubbleTargetAt(props.editor.state)
  if (!sameTarget(next, target.value)) editing.value = false
  target.value = next
  // Only selection and doc changes re-run `shouldShow`; a request or a dropped
  // one changes neither.
  if (transaction.getMeta(LINK_BUBBLE_KEY)) return
  const request = transaction.getMeta(BUBBLE_REQUEST_KEY) as BubbleRequest | null | undefined
  if (!next) {
    if (request === null) nextTick(() => toggle('hide'))
    return
  }
  if (!request) return
  nextTick(() => {
    emit('request')
    toggle('show')
    if (request.focus === 'url') startEdit()
    else if (request.focus === 'files') void pickFile()
    else focusFirst()
  })
}

function toggle(meta: 'show' | 'hide'): void {
  if (!props.editor.isDestroyed) props.editor.view.dispatch(props.editor.state.tr.setMeta(LINK_BUBBLE_KEY, meta))
}

function shouldShow({ editor, element, view, state }: { editor: Editor, element: HTMLElement, view: EditorView, state: EditorState }): boolean {
  if (props.held?.() || !editor.isEditable) return false
  if (!(view.hasFocus() || element.contains(document.activeElement))) return false
  return bubbleTargetAt(state) !== null
}

/** A link's whole range is the anchor, not the caret in it. */
function anchor() {
  const value = target.value
  if (value?.kind !== 'link' || props.editor.isDestroyed) return null
  const rect = posToDOMRect(props.editor.view, value.from, value.to)
  return { getBoundingClientRect: () => rect, getClientRects: () => [rect] }
}

// The editor may be destroyed before the bubble unmounts, and then has no view.
let dom: HTMLElement | undefined
onMounted(() => {
  props.editor.on('transaction', onTransaction)
  dom = props.editor.view.dom
  dom.addEventListener('keydown', tabIn, true)
})
onBeforeUnmount(() => {
  props.editor.off('transaction', onTransaction)
  dom?.removeEventListener('keydown', tabIn, true)
})
</script>

<template>
  <BubbleMenu
    :editor="editor"
    :plugin-key="LINK_BUBBLE_KEY"
    :should-show="shouldShow"
    :update-delay="0"
    :options="{ placement: 'bottom-start', offset: 8, shift: { padding: 8 }, ...options }"
    :get-referenced-virtual-element="anchor"
    tabindex="-1"
    class="z-10 rounded-md border border-default bg-default shadow-lg"
  >
    <div
      v-if="target && shown"
      ref="panel"
      role="dialog"
      :aria-label="KIND_NAME[target.kind]"
      data-testid="link-target-bubble"
      :data-kind="target.kind"
      class="flex items-center gap-1 p-1 text-sm"
      @keydown="onKeydown"
    >
      <form v-if="editing || isNewLink" class="flex items-center gap-1" @submit.prevent="apply">
        <UInput
          ref="field"
          v-model="url"
          size="sm"
          type="url"
          placeholder="https://…"
          :aria-label="target.kind === 'link' ? 'Link URL' : 'Citation URL'"
          :aria-invalid="invalid || undefined"
          :color="invalid ? 'error' : undefined"
          :highlight="invalid"
          data-testid="link-target-url"
          class="w-72"
          @update:model-value="invalid = false"
        />
        <UButton type="submit" size="sm" color="primary" variant="ghost" icon="i-lucide-check" aria-label="Apply" />
        <UButton
          v-if="files && target.kind === 'link'"
          size="sm"
          color="neutral"
          variant="ghost"
          icon="i-lucide-paperclip"
          aria-label="Link to a file"
          data-testid="link-target-choose-file"
          @click="pickFile"
        />
        <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-x" aria-label="Cancel" @click="close" />
      </form>
      <template v-else>
        <div class="min-w-0 max-w-80 px-1">
          <!-- Pointer only: the Open button is the keyboard's way. -->
          <a
            v-if="href"
            :href="href"
            :title="target.kind === 'link' ? href : undefined"
            target="_blank"
            rel="noopener noreferrer"
            tabindex="-1"
            data-testid="link-target"
            class="block truncate font-medium text-primary hover:underline"
          >{{ shown.heading }}</a>
          <span v-else data-testid="link-target" class="block truncate font-medium">{{ shown.heading }}</span>
          <p v-if="shown.detail" :title="shown.detail" class="truncate text-xs text-muted" data-testid="link-target-detail">{{ shown.detail }}</p>
          <p v-if="shown.blockLabel" class="truncate text-xs text-muted">{{ shown.blockLabel }}</p>
          <p v-if="shown.note" class="text-xs text-warning" data-testid="link-target-note">{{ shown.note }}</p>
        </div>
        <UButton
          :to="href || undefined"
          :disabled="!href"
          target="_blank"
          rel="noopener noreferrer"
          external
          size="sm"
          color="neutral"
          variant="ghost"
          icon="i-lucide-external-link"
          aria-label="Open in a new tab"
        />
        <UButton
          size="sm"
          color="neutral"
          variant="ghost"
          icon="i-lucide-pencil"
          :aria-label="`Change ${KIND_NAME[target.kind].toLowerCase()}`"
          @click="change"
        />
        <UButton
          size="sm"
          color="neutral"
          variant="ghost"
          :icon="target.kind === 'citation' ? 'i-lucide-trash-2' : 'i-lucide-unlink'"
          :aria-label="`Remove ${KIND_NAME[target.kind].toLowerCase()}`"
          @click="remove"
        />
      </template>
    </div>
  </BubbleMenu>
</template>
