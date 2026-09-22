<script setup lang="ts">
/**
 * Home: what this knowledge base holds, from the two endpoints that know —
 * `/api/kb` (every page the session may see) and `/api/spaces` (every space).
 * Nothing on this page is authored here; a KB with no content renders empty
 * states rather than a furnished demo. Both lists come from the chrome
 * composables, so this page and the sidebar share one request each.
 */
import { descriptionText, pageCountsBySpace, recentlyUpdated } from '#shared/utils/kb-spaces'

const { pages } = useKbPages()
const { spaces } = useSpaces()
const { canCreateSpace } = useCurrentUser()

const crumbs = [{ label: 'Home', icon: 'i-lucide-home' }]

const recent = computed(() => recentlyUpdated(pages.value, 8))

const spaceCards = computed(() => {
  const counts = pageCountsBySpace(pages.value)
  return spaces.value.map(space => ({
    id: space.id,
    name: space.name,
    slug: space.slug,
    description: descriptionText(space.description ?? ''),
    pages: counts.get(space.id) ?? 0,
  }))
})
</script>

<template>
  <ChromeAppNavbar :crumbs="crumbs" />

  <ChromePageBody>
    <main
      id="main-content"
      tabindex="-1"
      class="mx-auto flex w-full max-w-[1200px] flex-col gap-5 px-4 py-6 focus:outline-none sm:px-7"
    >
      <HeroCard :space-count="spaces.length" :page-count="pages.length" />

      <RecentlyUpdated :pages="recent" />

      <SpaceCards :spaces="spaceCards" :can-create="canCreateSpace" />

      <div
        v-if="!pages.length && !spaces.length"
        class="rounded-[12px] bg-default px-4 py-8 text-center text-[13px] italic text-muted shadow-[0_0_0_1px_var(--ui-border)]"
      >
        No pages yet.
      </div>
    </main>
  </ChromePageBody>
</template>
