<script setup lang="ts">
import { isTextSelection } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import type { EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { starterKitMarkdownOverrides } from '~/editor/extensions'
import { readUnreadSelection } from '~/editor/selection-sync'
import { useEditorSession } from '~/composables/useEditorSession'
import type { ReviewStep } from '#shared/page-blocks'

/**
 * The collab editor surface for the in-place edit mode of the read page.
 *
 * Renders ONLY the TipTap surface plus its overlay UI (bubble toolbar, drag
 * handle, slash menu, mentions, the `[[` document-link picker) — no chrome.
 * The page owns the chrome: it receives the whole editor session via the
 * `session` emit and renders the formatting toolbar + save/sync chips in the
 * app navbar, so entering edit mode adds zero layout height above the page
 * body.
 *
 * The `.inplace-editor` class strips the card look (padding, min-height) so
 * the ProseMirror content renders with the exact prose metrics of the read
 * column — see main.css.
 */
export type EditorSession = Awaited<ReturnType<typeof useEditorSession>>

const props = defineProps<{
  nid: number
  steps: readonly ReviewStep[]
  /** Whether this session may moderate past the four-eyes rule (ADR 0002). */
  mayModerate: boolean
}>()
const emit = defineEmits<{ (e: 'session', session: EditorSession): void }>()

const session = await useEditorSession(
  computed(() => props.nid),
  computed(() => props.steps),
  computed(() => props.mayModerate),
)
emit('session', session)

const {
  editorRef, extensions, comarkHandlers,
  slashItems, bubbleItems,
  mentionQuery, mentionItems,
  docItems, searchDocs, docLabel,
  blockMenu, hoveredBlock, openBlockMenu, closeBlockMenu, onBlockMenuCloseAutoFocus,
  selectBlockAt,
} = session

/**
 * The block the handle is floating over. `hover` carries the node as JSON,
 * which is all the item builders need — its type and, for a heading, its level.
 */
function rememberHoveredBlock({ node, pos }: { node: { type: string, attrs?: Record<string, unknown> }, pos: number }) {
  hoveredBlock.value = { pos, type: node.type, level: node.attrs?.level as number | undefined }
}

/**
 * Clicking the gutter beside a block selects the whole block, caret and all.
 *
 * That is the only way to address a component block — a callout, a table — as
 * one thing: clicking into it puts a caret in the text it holds. With the
 * block selected the native shortcuts do the rest, so cut, copy and paste
 * need no chrome of their own.
 *
 * The ⠿ sits in the same gutter and opens the menu instead, so a click that
 * came from it is left alone — taking the focus back into the editor here
 * would close the menu it just opened.
 */
function selectBlockFromGutter(event: MouseEvent) {
  const target = event.target as HTMLElement | null
  if (target?.closest('[data-testid="block-menu-trigger"]')) return
  const pos = hoveredBlock.value?.pos
  if (pos !== undefined) selectBlockAt(pos)
}

/**
 * The sticky edit navbar owns the top of the viewport: without it in the
 * flip's reckoning, a selection on the first line puts the menu behind it.
 */
const headerHeight = ref(0)
onMounted(() => {
  headerHeight.value = document.querySelector('header')?.offsetHeight ?? 0
})
const bubbleOptions = computed(() => ({ flip: { padding: { top: headerHeight.value + 8 } } }))

/**
 * The bubble stays down while the mouse button is down: TipTap runs
 * `shouldShow` on every selection change, so a drag would carry the menu over
 * the text it is selecting. The release dispatches the plugin's `show` meta
 * on the finished selection.
 */
const bubbleKey = new PluginKey('bubbleMenu')
/** Whether a mouse button is down in the surface. */
let pressed = false

watch(() => editorRef.value?.editor, (editor, _old, onCleanup) => {
  if (!editor) return

  /**
   * The `show` meta positions before it shows, and positioning is a no-op
   * while hidden — hence the second dispatch. A blurred editor gets nothing:
   * the plugin hid the menu on the blur. In a table a bare caret is enough.
   * The release can come before PM has read the click's selection.
   */
  const show = (): void => {
    if (editor.isDestroyed || !editor.view.hasFocus()) return
    readUnreadSelection(editor.view)
    if (editor.state.selection.empty && !editor.isActive('table')) return
    editor.view.dispatch(editor.state.tr.setMeta(bubbleKey, 'show'))
    editor.view.dispatch(editor.state.tr.setMeta(bubbleKey, 'updatePosition'))
  }
  // Only a mouse: a touch selection has no button to hold the menu down.
  const down = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') pressed = true
  }
  /**
   * Runs on `pointerup`, `pointercancel` and window blur: a press let go out
   * of reach never comes up, and the hold would stand.
   */
  const release = () => {
    if (!pressed) return
    pressed = false
    show()
  }
  /** A key ends the gesture: a keyboard selection must not wait for the button. */
  const key = () => { pressed = false }
  editor.view.dom.addEventListener('pointerdown', down, true)
  editor.view.dom.addEventListener('keydown', key, true)
  // A drag that runs past the surface releases outside it.
  document.addEventListener('pointerup', release, true)
  document.addEventListener('pointercancel', release, true)
  window.addEventListener('blur', release)
  onCleanup(() => {
    pressed = false
    editor.view.dom.removeEventListener('pointerdown', down, true)
    editor.view.dom.removeEventListener('keydown', key, true)
    document.removeEventListener('pointerup', release, true)
    document.removeEventListener('pointercancel', release, true)
    window.removeEventListener('blur', release)
  })
}, { immediate: true })

/**
 * The plugin's own conditions, plus the mouse hold. In a table a bare caret is
 * enough: the bubble carries that table's row and column controls.
 */
function bubbleShouldShow(
  { editor, element, view, state, from, to }:
  { editor: Editor, element: HTMLElement, view: EditorView, state: EditorState, from: number, to: number },
): boolean {
  if (pressed) return false
  const { doc, selection } = state
  const isEmptyTextBlock = !doc.textBetween(from, to).trim().length && isTextSelection(selection)
  const isChildOfMenu = element.contains(document.activeElement)
  if (!(view.hasFocus() || isChildOfMenu) || !editor.isEditable) return false
  return editor.isActive('table') || (!selection.empty && !isEmptyTextBlock)
}

/**
 * The caret's block is scrolled with room around it, not to the nearest edge:
 * ProseMirror's default lands a jumped-to block flush on the viewport's bottom.
 * `scrollThreshold` is how close to an edge counts as too close, `scrollMargin`
 * how much room the scroll then leaves.
 */
const SCROLL_ROOM = { top: 96, bottom: 160, left: 0, right: 0 }

const editorProps = {
  attributes: { id: 'page-editor' },
  scrollThreshold: SCROLL_ROOM,
  scrollMargin: SCROLL_ROOM,
}

/**
 * The handle has to be reachable from anywhere in its block.
 *
 * This surface strips the editor's own horizontal padding to hold the read
 * column's metrics, so the handle floats outside the ProseMirror box rather
 * than inside a gutter of it — and ProseMirror hides it the moment the pointer
 * leaves the block. So the handle takes the whole gutter beside its block as
 * its hit area: flush against the block's left edge (`mainAxis: 0`) and as
 * tall as the block (`size`). A pointer aimed at it from any line of a tall
 * paragraph lands on it rather than in dead ground.
 *
 * Only the hit area grows. The ⠿ itself stays a small button at the block's
 * top left (`items-start` on the root), where the 8px gap is now padding
 * inside the handle rather than a gap outside it.
 */
const dragHandleOptions = {
  offset: { mainAxis: 0, alignmentAxis: 0 },
  size: {
    apply({ rects, elements }: { rects: { reference: { height: number } }, elements: { floating: HTMLElement } }) {
      elements.floating.style.height = `${rects.reference.height}px`
    },
  },
}
</script>

<template>
  <ClientOnly>
    <!-- `page-editor` is the target of the edit navbar's "Skip to editor"
         link: a contenteditable element is focusable, so the fragment lands
         DOM focus in the surface and the keys bite again. -->
    <UEditor
      ref="editorRef"
      content-type="markdown"
      :starter-kit="{ history: false, undoRedo: false, ...starterKitMarkdownOverrides }"
      :mention="false"
      :image="false"
      :extensions="extensions"
      :handlers="comarkHandlers"
      :editor-props="editorProps"
      class="inplace-editor"
    >
      <template #default="{ editor }">
        <!-- Delay 0: TipTap's quarter-second hold leaves a fresh selection menu-less. -->
        <!-- The toolbar draws its `items` only. -->
        <UEditorToolbar
          :editor="editor"
          :items="bubbleItems"
          layout="bubble"
          :update-delay="0"
          :plugin-key="bubbleKey"
          :options="bubbleOptions"
          :should-show="bubbleShouldShow"
          data-testid="bubble-toolbar"
          class="rounded-md border border-default bg-default shadow-lg"
        />
        <!-- The handle is both grips: dragging it reorders the block, clicking
             it opens everything else that can be done to the block. The
             dropdown lives inside the handle's own slot so the two share one
             anchor — the same element floating-ui positions against the
             hovered block. -->
        <UEditorDragHandle
          :editor="editor"
          :options="dragHandleOptions"
          :ui="{ root: 'group items-start pe-2' }"
          @hover="rememberHoveredBlock"
        >
          <!-- The gutter fills the handle's hit area, so a click anywhere
               beside the block selects it. Pointer-only decoration, not a
               control: the ⠿ inside it and the toolbar's Block actions reach
               the same block from the keyboard, so it stays out of the a11y
               tree and out of the tab order — a focusable strip would cost a
               tab stop per block of the document. -->
          <div
            role="presentation"
            data-testid="block-gutter"
            class="h-full cursor-pointer"
            @click="selectBlockFromGutter"
          >
            <!-- `whitespace-normal`: the refusal a review item carries is a
                 sentence, and the theme truncates a description to one line. -->
            <UDropdownMenu
              :items="blockMenu"
              :content="{ align: 'start', side: 'bottom', onCloseAutoFocus: onBlockMenuCloseAutoFocus }"
              :ui="{ content: 'w-64', itemDescription: 'whitespace-normal' }"
              @update:open="open => open ? openBlockMenu() : closeBlockMenu()"
            >
              <!-- Two steps of feedback, because the hit area is bigger than
                   the button: the ⠿ lights up as soon as the pointer is
                   anywhere in the gutter, and again, stronger, once it is on
                   the button. `cursor-grab` is what the handle carries
                   upstream — dragging it is still what it does first. -->
              <UButton
                color="neutral"
                variant="ghost"
                size="sm"
                icon="i-lucide-grip-vertical"
                aria-label="Block actions"
                data-testid="block-menu-trigger"
                class="cursor-grab group-hover:bg-elevated hover:bg-accented active:cursor-grabbing"
              />
            </UDropdownMenu>
          </div>
        </UEditorDragHandle>
        <UEditorSuggestionMenu :editor="editor" :items="slashItems" />
        <UEditorMentionMenu
          v-model:search-term="mentionQuery"
          :editor="editor"
          :items="mentionItems"
          ignore-filter
        />
        <!-- One picker, two triggers: `[[` links, `[^` cites. -->
        <EditorDocLinkMenu
          v-for="mode in (['link', 'cite'] as const)"
          :key="mode"
          :editor="editor"
          :mode="mode"
          :items="docItems"
          :search="searchDocs"
          :resolve-label="docLabel"
        />
      </template>
    </UEditor>
  </ClientOnly>
</template>
