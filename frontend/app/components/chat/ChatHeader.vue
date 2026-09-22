<script setup lang="ts">
// Header chrome for the Ask OpenKnowledgebase band. Three blocks:
//   1. Violet-gradient sparkles mark + title + subtitle (matches the
//      design `.chat__h` band).
//   2. Scope picker — the shared space menu, over every space the reader can
//      see plus the whole knowledge base.
//   3. Overflow menu (UDropdownMenu) — clear conversation.
//
// The subtitle needs a band wider than the side pane's and yields below
// `@sm/band`, and so does the pill's label — the band has no room for both it
// and the title, and the composer names the scope there. Where the label does
// show it is capped short; the full name is on the pill's tooltip, in its
// accessible name, and in the menu's rows.
//
// Which model answers is the assistant's, set in Drupal; the turn's own
// reasoning line names it. This header picks no model.
//
// Closing belongs to whichever frame is around it, so it is not here.
import { spaceColor, spaceInitial } from '#shared/utils/kb-spaces'
import { SCOPE_ALL, SCOPE_ALL_LABEL, scopeLabel } from '#shared/utils/chat-scope'

/** The picked scope: `all`, or the slug of one space. */
const scope = defineModel<string>('scope', { required: true })

const emit = defineEmits<{
  (e: 'clear'): void
}>()

const { spaces } = useSpaces()

const menuOpen = ref(false)

const label = computed(() => scopeLabel(scope.value, spaces.value))

/** The picked space, where one is picked and loaded — its mark on the pill. */
const picked = computed(() => spaces.value.find(space => space.slug === scope.value) ?? null)

const overflowItems = computed(() => [
  [
    {
      label: 'Clear conversation',
      icon: 'i-lucide-trash-2',
      onSelect: () => emit('clear'),
    },
  ],
])
</script>

<template>
  <div class="flex min-w-0 flex-1 items-center gap-2.5">
    <span
      class="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-(--okb-agent-text) text-inverted shadow-sm"
    >
      <UIcon name="i-lucide-sparkles" class="size-4" />
    </span>
    <div class="min-w-0 flex-1">
      <div class="truncate text-sm font-semibold leading-tight text-(--ui-text-highlighted)">
        Ask OpenKnowledgebase
      </div>
      <div class="mt-0.5 hidden text-[11.5px] leading-tight text-(--ui-text-muted) @sm/band:block">
        Answers grounded in your spaces
      </div>
    </div>

    <SpaceMenu
      v-model:open="menuOpen"
      :selected="scope === SCOPE_ALL ? null : scope"
      :all-label="SCOPE_ALL_LABEL"
      align="end"
      @select="slug => { scope = slug ?? SCOPE_ALL }"
    >
      <!-- The pill is the mark plus a label capped short, so the header never
           wraps whatever a space is called. -->
      <button
        type="button"
        data-test="chat-scope-pill"
        :aria-label="`Search scope: ${label}. Change it.`"
        :title="label"
        class="inline-flex min-w-0 shrink-0 items-center gap-1.5 rounded-full bg-(--ui-bg-muted) px-2.5 py-1 text-[11.5px] text-(--ui-text-toned) ring-1 ring-(--ui-border) hover:bg-(--ui-bg-elevated)"
      >
        <span
          v-if="picked"
          class="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-[9px] font-bold text-white"
          :style="{ background: spaceColor(picked.internalId) }"
          aria-hidden="true"
        >{{ spaceInitial(picked.name) }}</span>
        <UIcon v-else name="i-lucide-database" class="size-3" />
        <span class="hidden max-w-[9rem] truncate font-medium text-(--ui-text-highlighted) @sm/band:block">{{ label }}</span>
        <UIcon name="i-lucide-chevron-down" class="size-3 text-(--ui-text-dimmed)" />
      </button>
    </SpaceMenu>

    <UDropdownMenu
      :items="overflowItems"
      :content="{ align: 'end', side: 'bottom' }"
    >
      <UButton
        icon="i-lucide-more-horizontal"
        color="neutral"
        variant="ghost"
        size="sm"
        data-test="chat-overflow"
        aria-label="Conversation options"
      />
    </UDropdownMenu>
  </div>
</template>
