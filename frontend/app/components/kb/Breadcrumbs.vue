<script setup lang="ts">
/**
 * `Space › ancestors › page` — the knowledge base's primary orientation
 * device, on the read page and on the space landing page.
 *
 * Derived, never stored: the trail is the ancestor chain of the current page
 * in the same outline the sidebar renders, so a drag repaints it in the same
 * tick and the two cannot disagree. A page the tree does not hold yet degrades
 * to `Space › page` rather than to nothing, since the space crumb has its own
 * source: the page response, passed in as `pageSpace`.
 *
 * A trail that would not fit middle-collapses to `Space › … › parent › page`,
 * with the collapsed ancestors in a popover. Both variants are always rendered
 * and chosen by breakpoint, so nothing measures and nothing reflows.
 */
const props = defineProps<{
  /** The page whose trail to render. Defaults to the current route. */
  path?: string
  /** Live title override — the editor's title changes before the page does. */
  title?: string
  /** Render the trail *of* a space (its landing page) rather than of a page. */
  space?: { name: string, slug: string } | null
  /**
   * The page's own space, as its response names it — the trail's anchor.
   *
   * It wins over the space the outline puts the page under: the outline is
   * fetched separately and arrives late on a cold load, and a page the tree
   * does not hold yet has no space in it at all.
   */
  pageSpace?: { name: string, slug: string } | null
}>()

interface Crumb {
  label: string
  to?: string
  icon?: string
}

const route = useRoute()
const { trailFor } = useKbOutline()

const target = computed(() => props.path ?? route.path)
const trail = computed(() => trailFor(target.value))

const ROOT: Crumb = { label: 'Spaces', to: '/', icon: 'i-lucide-folders' }

/** The space crumb, and where in `crumbs` it sits — the anchor of the trail. */
const spaceCrumb = computed<Crumb | null>(() => {
  if (props.space) return { label: props.space.name, icon: 'i-lucide-folder' }
  if (props.pageSpace) {
    return {
      label: props.pageSpace.name,
      to: `/${props.pageSpace.slug}`,
      icon: 'i-lucide-folder',
    }
  }
  const group = trail.value.space
  if (!group?.space) return null
  return {
    label: group.space.name,
    to: group.slug ? `/${group.slug}` : undefined,
    icon: 'i-lucide-folder',
  }
})

const crumbs = computed<Crumb[]>(() => {
  if (props.space) return [ROOT, spaceCrumb.value!]

  const nodes = trail.value.nodes
  const ancestors: Crumb[] = nodes.slice(0, -1).map(node => ({
    label: node.page.title,
    to: node.page.path,
  }))
  const current: Crumb = { label: props.title || nodes.at(-1)?.page.title || '' }

  return [ROOT, ...(spaceCrumb.value ? [spaceCrumb.value] : []), ...ancestors, current]
})

// What collapses: the ancestors between the space and the page's own parent.
// The space anchors the front and the parent the back — a trail that has lost
// either has lost the point of being a trail — so the generic "Spaces" root is
// what gives way, and parent + page are what a narrow screen keeps.
const headIndex = computed(() => (spaceCrumb.value ? 1 : 0))
const tailStart = computed(() => Math.max(headIndex.value + 1, crumbs.value.length - 2))
const collapsible = computed(() => crumbs.value.slice(headIndex.value + 1, tailStart.value))
const compact = computed<Crumb[]>(() => [
  crumbs.value[headIndex.value]!,
  ...crumbs.value.slice(tailStart.value),
])

/**
 * Which viewport the full trail needs before it is the better rendering.
 *
 * Depth decides, not width alone: a full trail squeezed into a width it cannot
 * have truncates every ancestor to a two-letter stub, which orients nobody. So
 * the deeper the trail, the wider the viewport it waits for; below that the
 * middle-collapsed variant takes over. Depth picks a breakpoint rather than a
 * measured width because both variants are in the DOM at all times — the
 * choice is CSS, identical on the server and the client, and switching it can
 * neither reflow nor jump.
 *
 * The thresholds are set against the room a trail actually gets: the header
 * shares its row with the page actions and gives up a fifth of the viewport to
 * the sidebar, so `Space › parent › page` is comfortable on a tablet while one
 * level more wants a laptop and two want a desktop.
 */
const FULL_AT = {
  md: ['hidden md:flex', 'md:hidden'],
  xl: ['hidden xl:flex', 'xl:hidden'],
  '2xl': ['hidden 2xl:flex', '2xl:hidden'],
} as const

const fullFrom = computed<keyof typeof FULL_AT>(() => {
  const depth = crumbs.value.length
  if (depth <= 4) return 'md'
  if (depth === 5) return 'xl'
  return '2xl'
})

const fullClass = computed(() => FULL_AT[fullFrom.value][0])
const compactClass = computed(() => FULL_AT[fullFrom.value][1])

const collapsedOpen = ref(false)
</script>

<template>
  <nav aria-label="Breadcrumb" data-testid="kb-breadcrumbs" class="flex min-w-0 items-center overflow-hidden">
    <!-- Wide enough for this trail's depth: the whole trail. -->
    <ol
      data-testid="kb-breadcrumbs-full"
      class="min-w-0 items-center gap-1"
      :class="fullClass"
    >
      <!-- Width priority: the space anchors the trail and the current page is
           what you are reading, so both keep their width; the ancestors in
           between are what truncate. -->
      <li
        v-for="(crumb, index) in crumbs"
        :key="`${crumb.label}-${index}`"
        class="flex items-center gap-1"
        :class="index <= headIndex ? 'shrink-0'
          : index < crumbs.length - 1 ? 'min-w-8 shrink'
            : 'min-w-16 max-w-64 shrink'"
      >
        <UIcon
          v-if="index > 0"
          name="i-lucide-chevron-right"
          class="size-3 shrink-0 text-dimmed"
        />
        <NuxtLink
          v-if="crumb.to"
          :to="crumb.to"
          class="flex min-w-0 items-center gap-1 text-[13px] text-muted hover:text-highlighted"
        >
          <UIcon v-if="crumb.icon" :name="crumb.icon" class="size-3.5 shrink-0" />
          <span class="truncate">{{ crumb.label }}</span>
        </NuxtLink>
        <span
          v-else
          class="flex min-w-0 items-center gap-1 text-[13px] font-medium text-highlighted"
          aria-current="page"
        >
          <UIcon v-if="crumb.icon" :name="crumb.icon" class="size-3.5 shrink-0" />
          <span class="truncate">{{ crumb.label }}</span>
        </span>
      </li>
    </ol>

    <!-- Too narrow for this depth: Space › … › parent › page, middle in a
         popover. -->
    <ol
      data-testid="kb-breadcrumbs-compact"
      class="flex min-w-0 items-center gap-1"
      :class="compactClass"
    >
      <li class="flex shrink-0 items-center gap-1">
        <NuxtLink
          :to="compact[0]!.to"
          class="flex items-center gap-1 text-[13px] text-muted hover:text-highlighted"
        >
          <UIcon v-if="compact[0]!.icon" :name="compact[0]!.icon" class="size-3.5 shrink-0" />
          <span class="truncate">{{ compact[0]!.label }}</span>
        </NuxtLink>
      </li>

      <li v-if="collapsible.length" class="flex shrink-0 items-center gap-1">
        <UIcon name="i-lucide-chevron-right" class="size-3 text-dimmed" />
        <UPopover v-model:open="collapsedOpen" :content="{ side: 'bottom', align: 'start' }">
          <button
            type="button"
            class="rounded px-1 text-[13px] text-muted hover:bg-elevated hover:text-highlighted"
            data-testid="kb-breadcrumbs-expand"
            :aria-label="`Show ${collapsible.length} hidden breadcrumb levels`"
          >
            …
          </button>
          <template #content>
            <ol data-testid="kb-breadcrumbs-collapsed" class="flex w-56 flex-col p-1">
              <li v-for="(crumb, index) in collapsible" :key="`${crumb.label}-${index}`">
                <NuxtLink
                  v-if="crumb.to"
                  :to="crumb.to"
                  class="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] text-toned hover:bg-elevated hover:text-highlighted"
                  :style="{ paddingInlineStart: `${8 + index * 10}px` }"
                  @click="collapsedOpen = false"
                >
                  <UIcon v-if="crumb.icon" :name="crumb.icon" class="size-3.5 shrink-0" />
                  <span class="truncate">{{ crumb.label }}</span>
                </NuxtLink>
              </li>
            </ol>
          </template>
        </UPopover>
      </li>

      <li
        v-for="(crumb, index) in compact.slice(1)"
        :key="`${crumb.label}-${index}`"
        class="flex items-center gap-1"
        :class="index < compact.length - 2
          ? 'min-w-10 max-w-[38%] shrink'
          : 'min-w-0 flex-1'"
      >
        <UIcon name="i-lucide-chevron-right" class="size-3 shrink-0 text-dimmed" />
        <NuxtLink
          v-if="crumb.to"
          :to="crumb.to"
          class="min-w-0 truncate text-[13px] text-muted hover:text-highlighted"
        >
          {{ crumb.label }}
        </NuxtLink>
        <span v-else class="min-w-0 truncate text-[13px] font-medium text-highlighted" aria-current="page">
          {{ crumb.label }}
        </span>
      </li>
    </ol>
  </nav>
</template>
