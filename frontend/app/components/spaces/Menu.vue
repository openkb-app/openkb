<script setup lang="ts">
/**
 * The one space menu: a search field over every space the session can see,
 * one row per match with its colour mark, and the row in force marked.
 *
 * Two surfaces render it and neither owns it — the sidebar's switcher, where a
 * row navigates to that space, and the chat's scope pill, where a row is the
 * scope the next turn is retrieved under. The trigger is each surface's own,
 * through the default slot; everything inside the popover is here.
 *
 * Own rows inside Nuxt UI's `UPopover` rather than `USelectMenu`: a row carries
 * a colour mark, a name that wraps and a description, which the select menu's
 * item shape has no room for.
 */
import { spaceColor, spaceInitial } from '#shared/utils/kb-spaces'

const props = defineProps<{
  /** The slug in force, marked in the list. */
  selected?: string | null
  /**
   * Label for a row standing for every space at once, emitted as `null`.
   *
   * Present makes the menu a choice — rows are `menuitemradio` and say which
   * one holds. Absent makes it a navigator, and there is no widest row to take.
   */
  allLabel?: string
  /** Which edge of the trigger the panel lines up with. */
  align?: 'start' | 'end'
}>()

const emit = defineEmits<{ (e: 'select', slug: string | null): void }>()

const open = defineModel<boolean>('open', { default: false })

const { spaces } = useSpaces()

const filter = ref('')
const search = useTemplateRef<HTMLInputElement>('search')
const panel = useTemplateRef<HTMLElement>('panel')

const matches = computed(() => {
  const needle = filter.value.trim().toLowerCase()
  if (!needle) return spaces.value
  return spaces.value.filter(space => space.name.toLowerCase().includes(needle))
})

/** The widest row answers to its own label, so typing reaches it too. */
const allMatches = computed(() => {
  if (!props.allLabel) return false
  const needle = filter.value.trim().toLowerCase()
  return !needle || props.allLabel.toLowerCase().includes(needle)
})

// A row is a menu item only where there is a menu around it; without a choice
// to mark it is a plain button that navigates.
const rowRole = computed(() => (props.allLabel ? 'menuitemradio' : undefined))

// The field is the reader's first move — "type to search" is why the menu is
// shared — so opening puts the caret in it rather than a row away from it.
watch(open, (isOpen) => {
  if (!isOpen) {
    filter.value = ''
    return
  }
  void nextTick(() => search.value?.focus())
})

function pick(slug: string | null) {
  open.value = false
  emit('select', slug)
}

/**
 * Up and down walk the rows, from the field as well as from a row: with the
 * caret in the search field there is no row to walk from, and the first one is
 * where the reader means to land.
 */
function onArrow(event: KeyboardEvent) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const rows = [...(panel.value?.querySelectorAll<HTMLElement>('[data-testid="space-option"]') ?? [])]
  if (!rows.length) return
  event.preventDefault()
  const at = rows.indexOf(document.activeElement as HTMLElement)
  const next = event.key === 'ArrowDown'
    ? (at + 1) % rows.length
    : (at <= 0 ? rows.length - 1 : at - 1)
  rows[next]?.focus()
}
</script>

<template>
  <UPopover v-model:open="open" :content="{ side: 'bottom', align: align ?? 'start' }">
    <slot />

    <template #content>
      <div ref="panel" class="w-72 p-1" data-testid="space-switcher-menu" @keydown="onArrow">
        <div class="m-1 flex items-center gap-2 rounded-md border border-default px-2 py-1.5">
          <UIcon name="i-lucide-search" class="size-3.5 text-dimmed" />
          <input
            ref="search"
            v-model="filter"
            data-testid="space-filter"
            placeholder="Find a space…"
            aria-label="Find a space"
            class="w-full bg-transparent text-sm outline-none placeholder:text-dimmed"
          >
        </div>

        <!-- A menu owns only its rows: the section heading is the
             navigator's, where there is no choice to mark. -->
        <div v-if="!allLabel" class="px-2.5 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-dimmed">
          Your spaces
        </div>

        <div
          class="flex flex-col gap-px"
          :role="allLabel ? 'menu' : undefined"
          :aria-label="allLabel ? 'Search scope' : undefined"
        >
          <button
            v-if="allMatches"
            type="button"
            :role="rowRole"
            :aria-checked="allLabel ? selected == null : undefined"
            :aria-label="allLabel"
            data-testid="space-option"
            class="flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-elevated focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--ui-primary)"
            :class="selected == null ? 'bg-primary/10' : ''"
            @click="pick(null)"
          >
            <span class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded bg-elevated" aria-hidden="true">
              <UIcon name="i-lucide-folders" class="size-3.5 text-dimmed" />
            </span>
            <span class="min-w-0 flex-1 break-words text-[13px] font-semibold text-highlighted">{{ allLabel }}</span>
            <UIcon v-if="selected == null" name="i-lucide-check" class="size-3.5 shrink-0 text-primary" />
          </button>

          <button
            v-for="space in matches"
            :key="space.id"
            type="button"
            :role="rowRole"
            :aria-checked="allLabel ? space.slug === selected : undefined"
            :aria-label="space.name"
            data-testid="space-option"
            class="flex min-h-11 items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-elevated focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--ui-primary)"
            :class="space.slug === selected ? 'bg-primary/10' : ''"
            @click="pick(space.slug)"
          >
            <span
              class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-[11px] font-bold text-white"
              :style="{ background: spaceColor(space.internalId) }"
              aria-hidden="true"
            >{{ spaceInitial(space.name) }}</span>
            <div class="min-w-0 flex-1">
              <!-- The row is where the full name is readable, so it wraps
                   where the trigger truncates. -->
              <div class="break-words text-[13px] font-semibold text-highlighted">
                {{ space.name }}
              </div>
              <div v-if="space.description" class="truncate text-[11.5px] text-muted">
                {{ space.description }}
              </div>
            </div>
            <UIcon v-if="space.slug === selected" name="i-lucide-check" class="size-3.5 shrink-0 text-primary" />
          </button>
        </div>

        <div v-if="!matches.length && !allMatches" class="px-2 py-2 text-xs italic text-dimmed">
          {{ spaces.length ? 'No space matches.' : 'No spaces yet.' }}
        </div>
      </div>
    </template>
  </UPopover>
</template>
