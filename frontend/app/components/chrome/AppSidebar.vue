<script setup lang="ts">
import { useMediaQuery } from '@vueuse/core'
import { spaceColor, spaceInitial } from '#shared/utils/kb-spaces'
import type { KbSpaceTree } from '#shared/utils/kb-outline'

const route = useRoute()
const { canCreateSpace } = useCurrentUser()

// The page trees, from the shared outline — the same value the breadcrumbs
// read, so a drag here moves both. A tree is the navigation *within* a space;
// which one the roster shows is `roster` below.
const { trees } = useKbOutline()

// Which space the switcher shows as current.
const { slug: activeSlug, space: activeSpace } = useActiveSpace()

const canCreatePage = useCanCreatePage(activeSlug)

/**
 * The tree the roster renders: the active space's, so the pages listed are the
 * pages of the space the rest of the chrome is talking about. Where no space is
 * in context — home, search — there is no roster: the switcher says "All
 * spaces" and the spaces themselves are reached through it.
 */
const roster = computed<KbSpaceTree | null>(() => (activeSpace.value
  ? trees.value.find(group => group.space?.id === activeSpace.value!.id) ?? null
  : null))

const spaceMenuOpen = ref(false)

/** A row of the shared menu; the sidebar applies the pick by navigating. */
function openSpace(slug: string | null) {
  return slug ? navigateTo(`/${slug}`) : undefined
}

/** Nuxt UI's collapsed flag, cookie-backed. The hover expansion never writes it. */
const collapsed = ref(false)
/** No hover expansion without a fine pointer. */
const hoverCapable = useMediaQuery('(hover: hover) and (pointer: fine)')
const pointerOver = ref(false)
const focusWithin = ref(false)

// A menu or dialog in the rail renders its content outside it, so the rail
// stays open for as long as one is on screen. The space popover is this
// component's own; the rest register through the hold.
const menuHolds = ref(0)
provide(railHoldKey, (held: boolean) => {
  menuHolds.value += held ? 1 : -1
})

const railOpen = computed(() => collapsed.value
  && (pointerOver.value || focusWithin.value || spaceMenuOpen.value || menuHolds.value > 0))

/**
 * What the slots render. Takes the slot's own flag, never the ref: the mobile
 * drawer renders these same slots with `collapsed: false`, and that is no rail.
 */
function showIconRail(slotCollapsed: boolean) {
  return slotCollapsed && !railOpen.value
}

/**
 * Chromium fires `pointerenter` when the growing rail's edge passes a pointer
 * that never moved; only a real move means the reader is on the rail.
 */
function onPointerMove(event: PointerEvent) {
  if (hoverCapable.value && event.pointerType === 'mouse') pointerOver.value = true
}

/** Clears what holds the rail open. */
function endVisit() {
  pointerOver.value = false
  focusWithin.value = false
}

function onFocusOut(event: FocusEvent) {
  const root = event.currentTarget as HTMLElement
  if (root.contains(event.relatedTarget as Node | null)) return
  focusWithin.value = false
}

/**
 * Any click ends the visit; pointerleave never comes while a navigation loads.
 * The outline's expand toggle is excluded — it rearranges the rail rather than
 * leaving it.
 */
function onClick(event: MouseEvent) {
  if ((event.target as Element | null)?.closest('[data-outline-toggle]')) return
  endVisit()
}

/**
 * Escape shrinks the rail, with the caret moved to the collapse control first:
 * the one control both states have, so the caret stays on screen. The move
 * lands before the flags are cleared, so it does not re-arm them.
 */
function onEscape(event: KeyboardEvent) {
  if (!railOpen.value) return
  const root = event.currentTarget as HTMLElement
  root.querySelector<HTMLElement>('[data-testid="sidebar-collapse"]')?.focus()
  endVisit()
}

// A route change always collapses the rail.
watch(() => route.fullPath, endVisit)

// The collapse control keeps pointer and focus, which would hold the rail open.
watch(collapsed, endVisit)
</script>

<template>
  <!-- w-64 paints 256px; -me-48 keeps the row's 64px, so the page does not
       reflow. -->
  <UDashboardSidebar
    id="default"
    v-model:collapsed="collapsed"
    data-testid="app-sidebar"
    :resizable="false"
    collapsible
    :default-size="18"
    :min-size="14"
    :max-size="26"
    :ui="{ root: [
      'bg-elevated/40 transition-[width,margin] duration-200 motion-reduce:transition-none',
      railOpen ? 'w-64 -me-48 z-40 bg-elevated shadow-lg' : '',
    ] }"
    @pointermove="onPointerMove"
    @pointerleave="pointerOver = false"
    @click="onClick"
    @focusin="focusWithin = true"
    @focusout="onFocusOut"
    @keydown.escape="onEscape"
  >
    <template #header="{ collapsed }">
      <NuxtLink
        to="/"
        aria-label="OpenKnowledgebase — home"
        class="flex min-w-0 items-center rounded-md px-1"
      >
        <ChromeLogo :variant="showIconRail(collapsed) ? 'mark' : 'lockup'" />
      </NuxtLink>
    </template>

    <template #default="{ collapsed }">
      <div v-if="!showIconRail(collapsed)" class="flex flex-col gap-2">
        <!-- The current space's avatar is the way to its home; it sits outside
             the popover trigger so a click on it navigates instead of opening
             the menu. -->
        <div class="flex min-h-11 w-full items-center rounded-md border border-default bg-default text-sm hover:border-accented">
          <NuxtLink
            v-if="activeSpace"
            :to="`/${activeSpace.slug}`"
            data-testid="space-home-link"
            :aria-label="`${activeSpace.name} — space home`"
            :title="`${activeSpace.name} — space home`"
            class="ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded hover:bg-elevated focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--ui-primary)"
          >
            <span
              class="inline-flex h-6 w-6 items-center justify-center rounded text-[11px] font-bold text-white"
              :style="{ background: spaceColor(activeSpace.internalId) }"
            >{{ spaceInitial(activeSpace.name) }}</span>
          </NuxtLink>
          <span v-else class="ml-1 flex h-9 w-9 shrink-0 items-center justify-center">
            <UIcon name="i-lucide-folders" class="size-4 text-dimmed" />
          </span>

          <div class="min-w-0 flex-1">
            <SpaceMenu
              v-model:open="spaceMenuOpen"
              :selected="activeSlug"
              @select="openSpace"
            >
              <button
                type="button"
                data-testid="space-switcher"
                class="flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1.5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--ui-primary)"
              >
                <span class="min-w-0 flex-1 truncate text-left font-semibold text-highlighted">
                  {{ activeSpace?.name ?? 'All spaces' }}
                </span>
                <UIcon name="i-lucide-chevrons-up-down" class="size-3.5 shrink-0 text-dimmed" />
              </button>
            </SpaceMenu>
          </div>
        </div>

        <NuxtLink
          to="/search"
          class="flex items-center gap-2 rounded-md border border-default bg-default px-2.5 py-1.5 text-sm text-muted hover:border-accented"
        >
          <UIcon name="i-lucide-search" class="size-3.5 text-dimmed" />
          <span>Search pages…</span>
          <!-- `value="meta"` renders ⌘ on macOS and Ctrl elsewhere — the same
               mapping `useAppShortcuts` applies to the handler. -->
          <span class="ml-auto flex gap-1" aria-hidden="true">
            <UKbd value="meta" /><UKbd value="k" />
          </span>
        </NuxtLink>

        <!-- Under the switcher rather than inside it: the switcher's popover
             unmounts its content on the outside click that opening a dialog
             is, which would take the dialog with it. The page CTA inherits the
             space in context, and asks for one where there is none. Both
             buttons take the width of their label, so neither grows into the
             sidebar; they wrap onto two rows where that does not fit. -->
        <div class="flex flex-wrap gap-1.5">
          <NewSpaceButton v-if="canCreateSpace" color="neutral" />
          <NewPageButton v-if="canCreatePage" :space="activeSlug" />
        </div>
      </div>

      <!-- The roster is the space the switcher already names, so it carries no
           heading of its own. -->
      <nav v-if="!showIconRail(collapsed) && roster" aria-label="Knowledge base pages" class="mt-2 px-1">
        <KbOutlineTree :space="roster" dense />
        <div v-if="!roster.tree.length" class="px-2 py-2 text-xs italic text-dimmed">
          No pages yet.
        </div>
      </nav>

      <!-- Collapsed rail: icon-only links, so each carries its own name. -->
      <nav v-if="showIconRail(collapsed)" aria-label="Knowledge base" class="flex flex-col items-center gap-2 py-2">
        <NuxtLink to="/" aria-label="Home" class="flex h-9 w-9 items-center justify-center rounded-md hover:bg-elevated">
          <UIcon name="i-lucide-home" class="size-4" aria-hidden="true" />
        </NuxtLink>
        <NuxtLink to="/search" aria-label="Search" class="flex h-9 w-9 items-center justify-center rounded-md hover:bg-elevated">
          <UIcon name="i-lucide-search" class="size-4" aria-hidden="true" />
        </NuxtLink>
      </nav>
    </template>

    <template #footer="{ collapsed }">
      <!-- `w-full`: the footer slot is itself a flex row, so this row is one of
           its items and would otherwise be only as wide as its content. The
           collapsed rail is one control wide, so its footer stacks instead. -->
      <div
        class="flex w-full gap-2 px-1"
        :class="showIconRail(collapsed) ? 'flex-col items-center' : 'items-center'"
      >
        <ChromeUserMenu :with-name="!showIconRail(collapsed)" :compact="showIconRail(collapsed)" />

        <!-- Client-only: the button is named for the scheme it switches *to*,
             which only the stored choice decides — and the server has no
             access to that. A name rendered on the server survives hydration,
             so it would go on naming the scheme the app is already in. -->
        <ClientOnly>
          <UColorModeButton
            data-testid="color-mode-toggle"
            size="sm"
            color="neutral"
            class="min-h-11 min-w-11 shrink-0 justify-center"
            :class="{ 'ml-auto': !showIconRail(collapsed) }"
          />
          <template #fallback>
            <div class="size-11 shrink-0" :class="{ 'ml-auto': !showIconRail(collapsed) }" />
          </template>
        </ClientOnly>

        <!-- The rail control, at the far end of the footer. Nuxt UI writes the
             collapsed state to the dashboard group's cookie, so the choice
             survives a reload. -->
        <UDashboardSidebarCollapse
          data-testid="sidebar-collapse"
          size="sm"
          class="min-h-11 min-w-11 shrink-0 justify-center"
        />
      </div>
    </template>
  </UDashboardSidebar>
</template>
