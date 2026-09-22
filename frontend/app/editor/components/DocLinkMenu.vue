<script lang="ts">
// The theme import needs a plain <script> block: `#build/ui/*` is a virtual
// module.
import theme from '#build/ui/editor-suggestion-menu'
</script>

<script setup lang="ts">
// Composes `useEditorMenu` directly: the ready-made suggestion menu filters and
// dispatches itself, but a search-backed picker needs the raw query and a
// pre-ranked list.
import { useEditorMenu } from '@nuxt/ui/composables/useEditorMenu'
import { tv } from '@nuxt/ui/utils/tv'
import { PluginKey } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/core'
import type { Transaction } from '@tiptap/pm/state'
import type { DocLinkItem } from '~/composables/useDocLinkSearch'
import { takeLinkSelection } from '~/editor/doc-link-selection'
import { reciteInBlock, takeCiteInsert } from '~/editor/cite-insert'
import { CITATION_TAG, citeTarget } from '#shared/utils/citations'

/**
 * The `[[` popover the editor offers pages and blocks in.
 *
 * It serves both inserts: a link by default, a citation where the block menu
 * opened it to cite (editor/cite-insert.ts). Same rows, same pick — only the
 * node differs.
 *
 * Built on Nuxt UI's `useEditorMenu`, so positioning and arrow/Enter/Escape
 * handling match the editor's other menus; only what a pick inserts is our own
 * (a `docLink` node, app/editor/nodes/doc-link.ts). Items arrive ranked and
 * access-filtered from the search, hence `ignore-filter`. `allowSpaces`
 * because the query is a page title; `allowedPrefixes: null` because the slash
 * menu and the toolbar insert `[[` mid-word. `resolveLabel` is a fetch, so the
 * insert position is mapped through the transactions it takes.
 */
const props = defineProps<{
  editor?: Editor
  items: DocLinkItem[]
  search: (query: string) => void
  resolveLabel: (item: DocLinkItem) => Promise<string>
}>()

/**
 * Rows answer the pointer only once it has moved. The popover opens at the
 * caret, where the pointer often already rests, and a row appearing under it
 * would take the highlight Enter then picks.
 */
const pointerLive = ref(false)
function armPointer() { pointerLive.value = true }

/**
 * Searches on every set, not on change: a bare `[[` re-announces the empty
 * query, which must still list pages.
 */
const searchTerm = customRef<string>((track, trigger) => {
  let value = ''
  return {
    get: () => { track(); return value },
    set: (next) => {
      value = next
      pointerLive.value = false
      trigger()
      props.search(next)
    },
  }
})

const appConfig = useAppConfig()
const slots = computed(() => tv({ extend: theme, ...(appConfig.ui as { editorSuggestionMenu?: object })?.editorSuggestionMenu || {} })({}))
const ui = computed(() => ({
  ...slots.value,
  content: (...args: unknown[]) => `${slots.value.content!(...args)}${pointerLive.value ? '' : ' pointer-events-none'}`,
}))

/** Whether the caret sits tight after a word, where comark needs a space. */
function spaceNeededAt(editor: Editor): boolean {
  const { from } = editor.state.selection
  if (from <= 1) return false
  const before = editor.state.doc.textBetween(from - 1, from, '', ' ')
  return before !== '' && !/\s/.test(before)
}

const MENU_ID = 'doc-link-menu'
const pluginKey = new PluginKey<{ active: boolean }>('docLinkMenu')

let menu: { plugin: unknown, destroy: () => void } | null = null
let container: HTMLElement | null = null
let observer: MutationObserver | null = null

/**
 * Gives the rendered rows ids and points the editor at the list and the
 * selected row. Focus never leaves the editor, so `aria-activedescendant` is
 * the only way a screen reader follows the highlight, and Nuxt UI's rows carry
 * no ids of their own.
 */
function syncAria() {
  const dom = props.editor?.view.dom as HTMLElement | undefined
  if (!dom || !container) return
  const rows = container.querySelectorAll<HTMLElement>('[role="option"]')
  if (!rows.length) {
    for (const name of ['aria-controls', 'aria-activedescendant']) dom.removeAttribute(name)
    return
  }
  const list = container.querySelector<HTMLElement>('[role="listbox"]')
  let selected = ''
  rows.forEach((row, index) => {
    if (!row.id) row.id = `${MENU_ID}-option-${index}`
    if (row.getAttribute('aria-selected') === 'true') selected = row.id
  })
  // A textbox may not carry `aria-expanded`; the active descendant carries the
  // state instead.
  if (list) {
    list.id = MENU_ID
    dom.setAttribute('aria-controls', MENU_ID)
  }
  else dom.removeAttribute('aria-controls')
  if (selected) dom.setAttribute('aria-activedescendant', selected)
  else dom.removeAttribute('aria-activedescendant')
}

/**
 * Makes Escape dismiss the suggestion, not only its popover, so `[[` can be
 * typed as text. `{ exit: true }` is the meta @tiptap/suggestion records the
 * dismissal in. Registered at mount, ahead of the menu's own capture handler.
 */
function dismissOnEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  const editor = props.editor
  if (!editor || editor.isDestroyed) return
  if (!pluginKey.getState(editor.state)?.active) return
  editor.view.dispatch(editor.view.state.tr.setMeta(pluginKey, { exit: true }))
}

onMounted(async () => {
  document.addEventListener('keydown', dismissOnEscape, true)
  document.addEventListener('pointermove', armPointer, { passive: true })
  // The popover's own container, so the observer sees only its mutations.
  container = document.createElement('div')
  container.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0'
  document.body.appendChild(container)
  observer = new MutationObserver(syncAria)
  observer.observe(container, { childList: true, subtree: true, attributeFilter: ['aria-selected'] })

  await nextTick()
  if (!props.editor || props.editor.isDestroyed) return
  menu = useEditorMenu({
    editor: props.editor,
    char: '[[',
    // Typed `string` upstream; the runtime takes a PluginKey, and only an
    // instance can address the plugin state the Escape dismissal reads.
    pluginKey: pluginKey as unknown as string,
    appendTo: () => container!,
    items: toRef(() => props.items),
    ignoreFilter: true,
    searchTerm,
    suggestion: { allowSpaces: true, allowedPrefixes: null },
    ui,
    onSelect: (editor: Editor, range: { from: number, to: number }, item: DocLinkItem) => {
      const citing = takeCiteInsert(range.from)
      // The words the `[[` replaced, if it was opened on a selection: they are
      // the label, and no title has to be resolved for one.
      const wrapped = takeLinkSelection(range.from)
      editor.chain().focus().deleteRange(range).run()
      // A citation carries a target and no words, so nothing has to resolve
      // before it is written.
      if (citing) {
        const target = citeTarget({ nid: item.nid, block: item.block, v: item.v })
        if (!target) return
        if (reciteInBlock(editor, target, item.v ?? null)) return
        editor.chain().focus().insertContent([
          // comark reads `:name{…}` as a component only after whitespace;
          // tight after a word the braces become the block's own props.
          ...(spaceNeededAt(editor) ? [{ type: 'text', text: ' ' }] : []),
          { type: CITATION_TAG, attrs: { nid: item.nid, block: item.block, v: item.v ?? null, url: null } },
          // Without the trailing space the caret has nowhere to land after
          // the atom.
          { type: 'text', text: ' ' },
        ]).run()
        return
      }
      let at = editor.state.selection.from
      const track = ({ transaction }: { transaction: Transaction }) => {
        at = transaction.mapping.map(at)
      }
      editor.on('transaction', track)
      const named = wrapped ? Promise.resolve(wrapped) : props.resolveLabel(item)
      named.then((label) => {
        // Leaving edit mode mid-resolve destroys the editor under this chain.
        if (editor.isDestroyed) return
        editor.chain().focus().insertContentAt(Math.min(at, editor.state.doc.content.size), [
          { type: 'docLink', attrs: { nid: item.nid, block: item.block, label } },
          // Without the trailing space the caret has nowhere to land after
          // the atom.
          { type: 'text', text: ' ' },
        ]).run()
      }).finally(() => {
        editor.off('transaction', track)
      })
    },
    renderItem: (item: DocLinkItem, styles: { value: Record<string, (arg?: unknown) => string> }) => [
      h(resolveComponent('UIcon'), { name: item.icon, class: styles.value.itemLeadingIcon!() }),
      h('span', { class: styles.value.itemWrapper!() }, [
        h('span', { class: styles.value.itemLabel!() }, item.label),
        h('span', { class: styles.value.itemDescription!() }, item.description),
      ]),
    ],
  }) as { plugin: unknown, destroy: () => void }
  props.editor.registerPlugin(menu.plugin as never)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', dismissOnEscape, true)
  document.removeEventListener('pointermove', armPointer)
  observer?.disconnect()
  observer = null
  menu?.destroy()
  menu = null
  if (props.editor && !props.editor.isDestroyed) {
    props.editor.unregisterPlugin(pluginKey)
    syncAria()
  }
  container?.remove()
  container = null
})
</script>

<template>
  <div />
</template>
