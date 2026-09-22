<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'

/**
 * The page's own action menu — actions about the page rather than about its
 * text. One menu holds them all, so the navbar never grows a second kebab.
 *
 * Read and edit mode offer the same entries. Only the two that act on a live
 * editing session — Attach file, Revert unsaved changes — are edit-only; every
 * other entry is gated on its own signal, so the menu does not change shape
 * with the mode.
 *
 * Move and Delete carry separate signals because they are separate Drupal
 * permissions: under editorial moderation an editor who may update a page
 * is not necessarily allowed to remove it. The signals only decide what is
 * worth offering; the server route enforces. Delete is irreversible from the
 * frontend, so it confirms in a dialog that names the page.
 *
 * The delete request goes to `DELETE /api/node/<nid>`, which settles the collab
 * session before deleting — see server/api/node/[id].delete.ts. It therefore
 * waits for a live editing session to be stood down, not just for a row to
 * disappear, which is what the confirm button's loading state covers.
 *
 * Leaving the page is the parent's call (it owns the editor session), so a
 * successful delete emits `deleted` rather than navigating.
 *
 * Where the page currently lives is fetched when the menu opens, not with the
 * page: the read view does not otherwise need it, and paying for it on every
 * page view would slow down the common case that never opens this menu.
 */
const props = defineProps<{
  nid: number
  title: string
  /** Drupal would let this session move the page to another space. */
  canMove?: boolean
  /** Drupal grants this session the delete. */
  canDelete?: boolean
  /** Editing: add the two actions that need a live document, and collapse the
   *  trigger to a plain kebab. The read view keeps the labelled "More" button. */
  edit?: boolean
  /** Unsaved collab changes exist — enables "Revert unsaved changes". */
  dirty?: boolean
  /** The page's revisions page, when this session may follow it. */
  historyHref?: string | null
  /** The page's raw-markdown endpoint. */
  markdownHref?: string
}>()
const emit = defineEmits<{ (e: 'deleted'): void, (e: 'attach'): void, (e: 'revert'): void }>()

const toast = useToast()
const moveOpen = ref(false)
const confirmOpen = ref(false)
const revertOpen = ref(false)
const deleting = ref(false)
const current = ref<{ id: string, name: string } | null>(null)

async function loadCurrentSpace() {
  if (current.value || !props.canMove) return
  try {
    const page = await $fetch<{ space: { id: string, name: string } | null }>(
      `/api/node/${props.nid}?version=default`,
    )
    current.value = page.space
  }
  catch (err) {
    // Not knowing the current space only costs the dialog its "this page is in
    // X" line and the exclusion of X from the picker — the move itself works.
    console.error('[page-menu] current space lookup failed:', err)
  }
}

const items = computed<DropdownMenuItem[][]>(() => {
  const groups: DropdownMenuItem[][] = []
  // What the reader can do with the document. Only Attach needs a live editing
  // session; the rest are true of the page in either mode, so they are gated
  // on their own signal rather than on `edit`.
  const docGroup: DropdownMenuItem[] = []
  if (props.edit) {
    docGroup.push({
      label: 'Attach file',
      icon: 'i-lucide-paperclip',
      onSelect: () => emit('attach'),
    })
  }
  // Always offered, disabled when there is nothing behind it: an entry that
  // vanishes reads as a broken page, a greyed one states that this page has
  // no revisions this session may open.
  docGroup.push({
    label: 'Versions',
    icon: 'i-lucide-history',
    to: props.historyHref ?? undefined,
    disabled: !props.historyHref,
  })
  if (props.markdownHref) {
    docGroup.push({
      label: 'View as Markdown',
      icon: 'i-lucide-file-code-2',
      to: props.markdownHref,
      target: '_blank',
    })
  }
  groups.push(docGroup)
  // Discarding the live draft needs one to exist.
  if (props.edit && props.dirty) {
    groups.push([{
      label: 'Revert unsaved changes',
      icon: 'i-lucide-undo-2',
      color: 'error' as const,
      onSelect: () => { revertOpen.value = true },
    }])
  }
  const pageGroup: DropdownMenuItem[] = []
  if (props.canMove) {
    pageGroup.push({
      label: 'Move to space…',
      icon: 'i-lucide-folder-input',
      onSelect: () => { moveOpen.value = true },
    })
  }
  if (props.canDelete) {
    pageGroup.push({
      label: 'Delete page…',
      icon: 'i-lucide-trash-2',
      color: 'error' as const,
      onSelect: () => { confirmOpen.value = true },
    })
  }
  if (pageGroup.length) groups.push(pageGroup)
  return groups
})

/**
 * Every listing (sidebar, space landing, home) renders from the `/api/kb` and
 * space payloads fetched with the page, so a move only shows up once those are
 * re-fetched.
 */
async function onMoved() {
  await refreshNuxtData()
}

function confirmRevert() {
  revertOpen.value = false
  emit('revert')
}

async function confirmDelete() {
  if (deleting.value) return
  deleting.value = true
  try {
    await $fetch(`/api/node/${props.nid}`, { method: 'DELETE' })
    confirmOpen.value = false
    emit('deleted')
    toast.add({
      title: 'Page deleted',
      description: `“${props.title}” has been moved to the trash.`,
      icon: 'i-lucide-trash-2',
    })
  }
  catch (err: unknown) {
    const e = err as { statusCode?: number, statusMessage?: string }
    toast.add({
      title: 'Delete failed',
      description: e?.statusCode === 403
        ? 'You do not have permission to delete this page.'
        : (e?.statusMessage ?? 'The page could not be deleted. Please try again.'),
      icon: 'i-lucide-triangle-alert',
      color: 'error',
    })
  }
  finally {
    deleting.value = false
  }
}
</script>

<template>
  <UDropdownMenu
    :items="items"
    :content="{ align: 'end', side: 'bottom' }"
    @update:open="open => open && loadCurrentSpace()"
  >
    <!-- Read view: bordered with a chevron and a "More" label — a ghost square
         kebab reads as decoration, not a control. Edit mode: a plain kebab in
         the fixed right cluster, where the row is already dense and the icon is
         the honest fit. -->
    <UButton
      color="neutral"
      :variant="edit ? 'ghost' : 'outline'"
      size="sm"
      icon="i-lucide-ellipsis"
      :trailing-icon="edit ? undefined : 'i-lucide-chevron-down'"
      aria-label="More actions"
      data-testid="page-menu"
    >
      <span v-if="!edit" class="hidden sm:inline">More</span>
    </UButton>
  </UDropdownMenu>

  <SpaceMoveDialog
    v-if="canMove"
    v-model:open="moveOpen"
    :nid="props.nid"
    :current="current"
    @moved="onMoved"
  />

  <UModal
    v-model:open="confirmOpen"
    title="Delete this page?"
    :description="`“${title}” moves to the trash and stops being readable. An administrator can restore it, with its revision history, until it is purged.`"
    :dismissible="!deleting"
  >
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :disabled="deleting"
          @click="confirmOpen = false"
        >
          Cancel
        </UButton>
        <UButton
          color="error"
          icon="i-lucide-trash-2"
          data-test="page-delete-confirm"
          :loading="deleting"
          @click="confirmDelete"
        >
          Delete page
        </UButton>
      </div>
    </template>
  </UModal>

  <!-- Reverting drops the live draft back to the last saved revision. It is
       destructive to unsaved work, so it confirms; the copy states what is
       lost and what is kept. -->
  <UModal
    v-if="edit"
    v-model:open="revertOpen"
    title="Revert unsaved changes?"
    description="The edits made since the last save are discarded and the document goes back to what is in history. Saved revisions are untouched."
  >
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          data-testid="page-menu-revert-cancel"
          @click="revertOpen = false"
        >
          Cancel
        </UButton>
        <UButton
          color="error"
          icon="i-lucide-undo-2"
          data-testid="page-menu-revert-confirm"
          @click="confirmRevert"
        >
          Discard changes
        </UButton>
      </div>
    </template>
  </UModal>
</template>
