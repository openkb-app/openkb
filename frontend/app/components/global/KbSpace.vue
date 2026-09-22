<script setup lang="ts">
/**
 * The `kb-space` element: a space's own page, served at its path alias.
 *
 * The payload carries name, alias and description. The page is the space's
 * dashboard: what changed here lately, a search box scoped to it, and the way
 * into the chat. Its settings — roster, read access, editing workflow — live
 * behind the Settings dialog, which only a manager is offered.
 *
 * The space the dialog writes comes from `/api/spaces/<slug>`, which is what it
 * writes back to, so an edit there refreshes without a page load.
 */
import { descriptionText, recentlyUpdated, spaceSlug } from '#shared/utils/kb-spaces'

// Flat props off the CE display.
const props = defineProps<{
  name?: string
  /** The space's path alias — its own URL, and the slug the API takes. */
  path?: string
  description?: string
}>()

const slug = computed(() => spaceSlug(props.path ?? ''))

// The space the settings dialog edits. An unknown — or invisible — space 404s
// here: the fetch reports that as `error` instead of throwing, so the page
// raises it.
const { data: space, error: spaceError } = await useSpaceDetail(slug)

if (spaceError.value || !space.value) {
  throw createError({ statusCode: 404, statusMessage: 'Space not found', fatal: true })
}

const canCreatePage = useCanCreatePage(slug)
const { pages } = useKbPages()
const { openChat } = useSidePane()

const title = computed(() => props.name ?? space.value?.name ?? slug.value)
// The API's copy first: a settings save renews it, the CE payload behind it not.
const description = computed(() => descriptionText(space.value?.description ?? props.description ?? ''))

const recent = computed(() =>
  recentlyUpdated(pages.value.filter(page => page.space?.id === space.value?.id), 8),
)

const settingsOpen = ref(false)
const query = ref('')

function search() {
  void navigateTo({ path: '/search', query: { q: query.value.trim(), space: slug.value } })
}
</script>

<template>
  <ChromeAppNavbar>
    <template #leading>
      <KbBreadcrumbs :space="{ name: title, slug }" />
    </template>
  </ChromeAppNavbar>

  <ChromePageBody>
    <main
      id="main-content"
      tabindex="-1"
      class="mx-auto flex w-full max-w-[1200px] flex-col gap-5 px-4 py-6 focus:outline-none sm:px-7"
    >
      <header class="flex flex-wrap items-center gap-2">
        <UIcon name="i-lucide-folder" class="size-5 text-muted" />
        <h1 class="text-[20px] font-semibold tracking-tight text-highlighted">
          {{ title }}
        </h1>
        <div class="ml-auto flex items-center gap-2">
          <UButton
            v-if="space?.canManage"
            color="neutral"
            variant="outline"
            size="sm"
            icon="i-lucide-settings"
            aria-haspopup="dialog"
            data-testid="space-settings-open"
            @click="settingsOpen = true"
          >
            Settings
          </UButton>
          <!-- Creation inherits the space it is invoked from: this one. -->
          <NewPageButton v-if="canCreatePage" :space="slug" />
        </div>
      </header>

      <p v-if="description" data-testid="space-description" class="max-w-[70ch] text-[14px] leading-relaxed text-muted">
        {{ description }}
      </p>

      <div class="flex flex-wrap items-center gap-2">
        <!-- A real GET form to the search page, so it works before hydration
             too; the handler upgrades it to a client-side navigation. -->
        <form
          action="/search"
          method="get"
          class="flex min-w-[260px] flex-1 flex-wrap items-center gap-2"
          data-testid="space-search"
          @submit.prevent="search"
        >
          <input type="hidden" name="space" :value="slug">
          <UInput
            v-model="query"
            name="q"
            class="min-w-[220px] flex-1"
            size="md"
            icon="i-lucide-search"
            :placeholder="`Search ${title}…`"
            :aria-label="`Search ${title}`"
            data-testid="space-search-input"
          />
          <UButton type="submit" color="neutral" variant="outline" size="md" data-testid="space-search-submit">
            Search
          </UButton>
        </form>

        <!-- The chat answers across every space the reader may read; scoping it
             to this one is a retriever setting that does not exist yet. -->
        <UButton
          color="neutral"
          variant="outline"
          size="md"
          icon="i-lucide-sparkles"
          data-testid="space-chat-open"
          @click="openChat()"
        >
          Ask OpenKnowledgebase
        </UButton>
      </div>

      <RecentlyUpdated :pages="recent" :show-space="false" />

      <p
        v-if="!recent.length"
        data-testid="space-no-pages"
        class="rounded-[12px] bg-default px-4 py-8 text-center text-[13px] italic text-muted shadow-[0_0_0_1px_var(--ui-border)]"
      >
        No pages yet.
      </p>

      <SpaceDialog
        v-if="space?.canManage"
        v-model:open="settingsOpen"
        :space="space"
        @updated="value => (space = value)"
      />
    </main>
  </ChromePageBody>
</template>
