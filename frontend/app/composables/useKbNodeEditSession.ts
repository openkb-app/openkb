import { createHandlers } from '@nuxt/ui/utils/editor'
import type { EditorSession } from '~/components/PageInlineEditor.vue'
import { comarkHandlers } from '~/editor/menu-items'
import { addressableBlocks } from '~/editor/review-marks'
import type { KbCePageContext } from '~/composables/useKbCePage'

type Mode = 'read' | 'preparing' | 'edit'

interface EditSessionOptions {
  /** The node this edits, off the component's flat props. */
  nid: Ref<string | number | undefined>
  /** Re-read moderation after a save lands a forward draft. */
  refreshModeration: () => Promise<void>
}

/**
 * The editable-node edit session: one route (the CE page) serves read AND edit.
 *
 * Pressing Edit does NOT navigate. The collab editor mounts hidden in the same
 * content column ('preparing': the read view stays visible and interactive) and
 * only when the session is connected + the doc hydrated does one atomic swap
 * replace the rendered body with the live ProseMirror surface. The column keeps
 * identical metrics in both modes, so the first paragraph does not move.
 *
 * The machinery is content-type agnostic — a second editable node type
 * (`node-report`, …) wires the same session and declares only its own read
 * surface. `env` is the page envelope (`useKbCePage`): the reseat after a save
 * belongs to the catch-all that owns the fetched page, so the exit refresh
 * calls `env.refresh` rather than re-fetching a copy.
 */
export function useKbNodeEditSession(env: KbCePageContext, opts: EditSessionOptions) {
  const route = useRoute()
  const toast = useToast()

  const mode = ref<Mode>('read')
  const session = shallowRef<EditorSession | null>(null)
  const fmOpen = ref(false)

  const editorInstance = computed(() => session.value?.editorRef.value?.editor ?? null)

  /** The edit surface reports its session up once PageInlineEditor mounts. */
  function setSession(s: EditorSession | null) {
    session.value = s
  }

  // The formatting toolbars mount in the app navbar — OUTSIDE <UEditor> — so
  // they cannot inject the handler map UEditor provides to its own subtree.
  // Provide the same merged map here: without it, every custom handler kind
  // (table ops, callout, infobox, image) silently no-ops from the navbar.
  provide('editorHandlers', computed(() => ({ ...createHandlers(), ...comarkHandlers })))

  /** Atomic mode swap; uses the View Transitions API when present (progressive
   * enhancement — the instant swap is the universal path). */
  function swap(to: Mode) {
    const apply = () => { mode.value = to }
    const doc = document as Document & { startViewTransition?: (cb: () => void) => void }
    if (typeof doc.startViewTransition === 'function') doc.startViewTransition(apply)
    else apply()
  }

  function startEdit() {
    if (mode.value !== 'read' || !opts.nid.value || !env.canEdit.value) return
    // Edit mode lives in the URL (`?edit`), so it survives navigation: leaving
    // the page and pressing Back returns to the editor rather than to a read
    // view. Pushing (not replacing) makes Back leave the editor the same way it
    // was entered. `exitToRead` drops the query, so a reload after exiting does
    // not reopen it.
    if (route.query.edit === undefined) {
      navigateTo({ path: route.path, query: { ...route.query, edit: '' } })
    }
    // Mounts the hidden editor; the read view stays untouched until the swap.
    mode.value = 'preparing'
  }

  /**
   * Puts the caret in the block with this id. A block the editor does not carry
   * — a list, a table (comark 0.5 mints no id there) — leaves the caret where
   * it was.
   */
  function goToBlockId(blockId: string) {
    const doc = editorInstance.value?.state.doc
    const block = doc ? addressableBlocks(doc).find(b => b.id === blockId) : undefined
    if (block) session.value?.goToBlock(block.pos)
  }

  // Where the caret goes once the editor is live: the document only exists
  // after the swap.
  let caretBlock: string | null = null

  /** Enters edit mode with the caret in one block, named by its id. */
  function startEditAtBlock(blockId: string) {
    startEdit()
    if (mode.value === 'preparing') caretBlock = blockId
  }

  watch(mode, (m) => {
    if (m !== 'edit' || !caretBlock) return
    goToBlockId(caretBlock)
    caretBlock = null
  })

  // A session-setup failure inside the editor subtree (page fetch, collab
  // wiring) must not strand the reader in 'preparing' or on a dead edit
  // surface — surface the error and fall back to the intact read view.
  onErrorCaptured((err) => {
    if (mode.value === 'read') return true
    console.error('[kb-page] editor session failed:', err)
    mode.value = 'read'
    toast.add({
      title: 'Editing unavailable',
      description: 'The editing session could not be started. Please try again.',
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
    return false
  })

  // Swap in once the collab session is synced and the editor is mounted. If the
  // collab server can't be reached the local-first editor still works — go
  // ahead after a timeout instead of hanging in 'preparing' forever.
  let readyTimeout: ReturnType<typeof setTimeout> | null = null
  watch(mode, (m) => {
    if (m === 'preparing') {
      readyTimeout = setTimeout(() => {
        if (mode.value === 'preparing') swap('edit')
      }, 10000)
    }
    else if (readyTimeout) {
      clearTimeout(readyTimeout)
      readyTimeout = null
    }
    if (m === 'read') {
      session.value = null
      fmOpen.value = false
    }
  })
  watchEffect(() => {
    if (mode.value !== 'preparing') return
    const s = session.value
    if (!s || !s.synced.value || !s.editorRef.value?.editor) return
    nextTick(() => swap('edit'))
  })

  /**
   * The read payload, and the page list with it: a write can change the
   * title, and the sidebar, the space listings and the home page read titles
   * from `/api/kb`, not from this page's payload.
   */
  async function refreshPage() {
    await Promise.all([env.refresh(), refreshNuxtData('okb-pages')])
  }

  // Save and Close exit identically: fresh read payload (via the catch-all's
  // reseat), then the same transition as read→edit (symmetric in/out), and no
  // ?edit left in the URL (a reload after exiting must not reopen the editor).
  async function exitToRead() {
    await refreshPage()
    swap('read')
    if (route.query.edit !== undefined) {
      const { edit: _drop, ...query } = route.query
      navigateTo({ path: route.path, query }, { replace: true })
    }
  }

  async function save() {
    if (!(await session.value?.save())) return
    // A checkpoint on a published page lands a forward draft, so the badge's
    // "unpublished changes" is only true after this write — refresh before the
    // chrome swaps back to read mode.
    await opts.refreshModeration()
    await exitToRead()
  }

  // --- Deletion --------------------------------------------------------------
  //
  // Whoever deleted the page leaves this page; there is nothing to read here
  // any more. Two entry points end up in the same place — this session did it,
  // or a peer did it while this session had the editor open — and the flag keeps
  // the second from also announcing what the first already reported.
  const deletedHere = ref(false)

  function leaveDeletedPage() {
    // Drop out of edit mode first: the editor's session belongs to a document
    // that no longer exists, and exiting through the normal path would try to
    // re-read the deleted page.
    mode.value = 'read'
    return navigateTo('/')
  }

  function onDeleted() {
    deletedHere.value = true
    void leaveDeletedPage()
  }

  watch(() => session.value?.deletedRemotely.value, (isDeleted) => {
    if (!isDeleted || deletedHere.value) return
    toast.add({
      title: 'Page deleted',
      description: 'Someone deleted this page while you were editing it. Your unsaved changes were not kept.',
      icon: 'i-lucide-trash-2',
      color: 'warning',
    })
    void leaveDeletedPage()
  })

  function closeEditor() {
    void exitToRead()
  }

  // Deep link (/kb/<slug>?edit — also the /node/<id>/edit redirect target)
  // starts the preload once hydration has settled, keeping SSR/hydration
  // purely read-mode (mutating mode mid-hydration re-creates the subtree).
  onNuxtReady(() => {
    if (route.query.edit !== undefined) startEdit()
  })

  // The catch-all component is reused across page routes, so a client-side
  // navigation back onto a `?edit` URL (the Back button after leaving the
  // editor) does not re-run setup — onNuxtReady already fired. Watch the query
  // so that return reopens the editor. Non-immediate: the first load is
  // onNuxtReady's, and mutating mode mid-hydration re-creates the subtree.
  watch(() => route.query.edit, (edit) => {
    if (edit !== undefined && mode.value === 'read') startEdit()
  })

  // The title tracks the live frontmatter title while editing, and is the
  // page's own title otherwise — the read title for the H1 and the trail.
  const title = computed(() => {
    if (mode.value === 'edit' && session.value) {
      return (session.value.frontmatter.field('title').value as string | null) ?? env.title.value ?? ''
    }
    return env.title.value ?? ''
  })

  return {
    mode,
    session,
    setSession,
    fmOpen,
    editorInstance,
    title,
    startEdit,
    startEditAtBlock,
    goToBlockId,
    closeEditor,
    save,
    exitToRead,
    refreshPage,
    onDeleted,
  }
}

export type KbNodeEditSession = ReturnType<typeof useKbNodeEditSession>
