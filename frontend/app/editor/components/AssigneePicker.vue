<script setup lang="ts">
// Explicit, not auto-imported: the component is rendered by its own vitest
// suite outside a Nuxt app.
import { computed, ref, watch, type ComponentPublicInstance } from 'vue'
import type { AssigneeCandidate } from '../comment-assignee'
import { ownedLabel } from '#shared/utils/attribution'
import EditorPeerAvatar from './PeerAvatar.vue'
import type { CommentAssignee } from '#shared/block-comments'

/**
 * Who to hand a comment thread to — the one picker the composer's `@` and the
 * thread's assignee chip both open. A `UCommandPalette` in a `UPopover`, so the
 * search and the keyboard are the palette's.
 */
const props = defineProps<{
  candidates: AssigneeCandidate[]
  /** Offer "Unassign" — the thread already has somebody. */
  allowUnassign?: boolean
  /** The reader's own account, so their agents read as theirs. */
  viewerUid?: number | null
  /**
   * What the palette is placed against, when it is not the trigger: the
   * composer it is written into, so a palette with no room under it opens over
   * the list above rather than over the draft.
   */
  anchor?: HTMLElement | null
}>()

const emit = defineEmits<{ pick: [CommentAssignee | null] }>()

const open = defineModel<boolean>('open', { default: false })

const searchTerm = ref('')

/**
 * Rows the resting list shows: what fits under the composer at drawer width
 * without the list having to scroll. Typing narrows it, and a list longer than
 * this scrolls rather than growing over the words it is being written into.
 */
const RESTING_ROWS = 8

/** What had focus when the picker opened, and whether a pick closed it. */
let cameFrom: HTMLElement | null = null
let picking = false

watch(open, (is) => {
  if (!is) return
  searchTerm.value = ''
  cameFrom = document.activeElement as HTMLElement | null
  picking = false
})

function choose(who: CommentAssignee | null): void {
  emit('pick', who)
  picking = true
  open.value = false
}

/**
 * A pick leaves the writer mid-sentence, so focus goes back where the picker
 * was opened from — the popover's own restore is its trigger instead.
 *
 * Not once a press elsewhere has taken the keyboard: the palette hands focus
 * back a frame after it closes, and a control pressed in that frame owns the
 * caret. Pulling it onto a composer that press is about to close leaves the
 * focus on a detached node, which the drawer around it reads as a press
 * outside itself.
 */
function keepFocus(event: Event): void {
  if (!picking || !cameFrom?.isConnected) return
  const active = document.activeElement
  const palette = event.target
  if (active && active !== document.body && palette instanceof Node && !palette.contains(active)) return
  event.preventDefault()
  cameFrom.focus()
}

/**
 * Tab commits to the highlighted row, the way Enter does: the palette
 * highlights its first row as it opens, so Tab straight after typing a name
 * takes the best match. Shift+Tab is the way back out, and picks nobody.
 */
function commitOnTab(event: KeyboardEvent): void {
  if (event.key !== 'Tab' || event.shiftKey) return
  const root = event.currentTarget as HTMLElement
  const row = root.querySelector<HTMLElement>('[role="option"][data-highlighted]')
  if (!row) return
  event.preventDefault()
  row.click()
}

/**
 * The palette passes no attributes to its listbox, which needs a name.
 * Its root is a fragment, so the listbox is looked up from the popover around it.
 */
function nameListbox(palette: Element | ComponentPublicInstance | null): void {
  if (!palette || !('$el' in palette)) return
  const popover = (palette.$el as Node).parentElement
  popover?.querySelector('[role="listbox"]')?.setAttribute('aria-label', 'People and agents to assign')
}

function itemOf(candidate: AssigneeCandidate) {
  return {
    label: ownedLabel(candidate, props.viewerUid ?? null),
    suffix: candidate.present
      ? 'In the page now'
      : (candidate.via ? 'Offline' : undefined),
    // The row draws its own avatar (`#item-leading`), so an agent wears the
    // same mark here as in the presence strip.
    peer: candidate,
    onSelect: () => choose({ uid: candidate.uid, name: candidate.name, via: candidate.via ?? null }),
  }
}

interface PaletteGroup {
  id: string
  label?: string
  items: ReturnType<typeof itemOf>[]
}

/**
 * At most `RESTING_ROWS` rows, taken a row per group at a time so no group is
 * cut away whole — the reader's own agents keep a row however long the space's
 * roster is. Typing searches every candidate, so a row left out here is one
 * keystroke away.
 */
function fit(groups: PaletteGroup[]): PaletteGroup[] {
  if (groups.reduce((rows, group) => rows + group.items.length, 0) <= RESTING_ROWS) return groups
  const kept = groups.map(group => ({ ...group, items: [] as PaletteGroup['items'] }))
  let left = RESTING_ROWS
  for (let row = 0; left > 0; row++) {
    const items = groups.map(group => group.items[row])
    if (items.every(item => !item)) break
    items.forEach((item, at) => {
      if (!item || left === 0) return
      kept[at]!.items.push(item)
      left--
    })
  }
  return kept.filter(group => group.items.length)
}

const groups = computed(() => {
  const people = props.candidates.filter(candidate => !candidate.via)
  const agents = props.candidates.filter(candidate => candidate.via)
  const offered: PaletteGroup[] = [
    { id: 'here', label: 'In the page', items: people.filter(p => p.present).map(itemOf) },
    { id: 'space', label: 'Space editors', items: people.filter(p => !p.present).map(itemOf) },
    { id: 'agents', label: 'Agents here', items: agents.filter(a => a.present).map(itemOf) },
    { id: 'my-agents', label: 'My agents', items: agents.filter(a => !a.present).map(itemOf) },
  ].filter(group => group.items.length)
  return [
    // Typing hands the palette every candidate to search; the cap is what the
    // list rests at.
    ...(searchTerm.value ? offered : fit(offered)),
    ...(props.allowUnassign
      ? [{
          id: 'none',
          items: [{
            label: 'Unassign',
            icon: 'i-lucide-user-minus',
            onSelect: () => choose(null),
          }],
        }]
      : []),
  ]
})
</script>

<template>
  <!-- Placed against the whole composer rather than the small button in it,
       and no taller than the room on the side it takes: short of room under
       the composer it opens above it, over the list, never over the words it
       is being written into. -->
  <UPopover
    v-model:open="open"
    :reference="anchor ?? undefined"
    :content="{
      side: 'bottom',
      align: 'start',
      collisionPadding: 8,
      onCloseAutoFocus: keepFocus,
    }"
    :ui="{ content: 'max-h-(--reka-popover-content-available-height) flex flex-col' }"
  >
    <slot />
    <template #content>
      <UCommandPalette
        :ref="nameListbox"
        v-model:search-term="searchTerm"
        :groups="groups"
        :fuse="{ fuseOptions: { keys: ['label'] }, resultLimit: RESTING_ROWS }"
        placeholder="Search people and agents…"
        class="w-72 max-w-[80vw] min-h-0"
        data-testid="assignee-picker"
        @keydown="commitOnTab"
      >
        <template #item-leading="{ item }">
          <EditorPeerAvatar
            v-if="item.peer"
            size="2xs"
            :name="item.peer.name"
            :color="item.peer.color"
            :via="item.peer.via"
          />
          <UIcon
            v-else-if="item.icon"
            :name="item.icon"
            class="size-5 shrink-0 text-dimmed transition-colors group-data-highlighted:not-group-data-disabled:text-default"
          />
        </template>

        <template #empty>
          <p class="p-2 text-sm text-muted">
            Nobody to assign here.
          </p>
        </template>
      </UCommandPalette>
    </template>
  </UPopover>
</template>
