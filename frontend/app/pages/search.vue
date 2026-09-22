<script setup lang="ts">
import type { UIMessage, ReasoningUIPart } from 'ai'
import type { DropdownMenuItem } from '@nuxt/ui'
import { useDebounceFn } from '@vueuse/core'
import { backendUrl } from '#shared/utils/user'
import type { PageSearchResponse } from '#shared/utils/kb-search'
import { rowLink, rowExcerptParts, excerptParts, subSections, sectionLabel, sectionsLabel, changedOn, UPDATED_RANGES } from '#shared/utils/kb-search'
import type { TitleSuggestion } from '~/composables/useTitleSuggest'
import { toFormModel, type FrontmatterReferenceTarget, type FrontmatterSchema } from '../editor/frontmatter-model'
import type { EntityRef } from '~/composables/useEntityFields'

const route = useRoute()
const router = useRouter()
const {
  content: paneContent,
  hidden: paneHidden,
  wide: paneWide,
  openChat,
} = useSidePane()

/** The query as the URL has it: what is searched for, never the box. */
const routeQuery = computed(() => (typeof route.query.q === 'string' ? route.query.q : ''))

/** The window as the URL has it, zero-based. */
const routePage = computed(() => Math.max(0, Number(route.query.page) || 0))

/** The space as the URL has it: its slug, which the route narrows by. */
const routeSpace = computed(() => (typeof route.query.space === 'string' ? route.query.space : ''))

/** The document type as the URL has it, by machine name. */
const routeType = computed(() => (typeof route.query.type === 'string' ? route.query.type : ''))

/** The author as the URL has it: their user name, which the row carries. */
const routeAuthor = computed(() => (typeof route.query.author === 'string' ? route.query.author : ''))

/** The update window as the URL has it, by {@link UPDATED_RANGES} key. */
const routeUpdated = computed(() => (typeof route.query.updated === 'string' ? route.query.updated : ''))

/** What is in the box. A search runs when it is submitted, not as it is typed. */
const draft = ref(routeQuery.value)
watch(routeQuery, (q) => { draft.value = q })

const { suggestions, suggest, clear: clearSuggestions } = useTitleSuggest(routeSpace)

/** Whether the offers are on screen. */
const suggestOpen = ref(false)

/**
 * The offered row the keyboard is on, -1 for none.
 *
 * Nothing is selected until an arrow key selects it, so Enter on the bare box
 * runs the search rather than opening whichever page happened to lead.
 */
const activeRow = ref(-1)

/** The rows Enter can land on: the offers, then the search itself. */
const rowCount = computed(() => suggestions.value.length + 1)

/**
 * Whether the list is on screen.
 *
 * The last row always runs the search, so the list opens on what was typed
 * rather than on whether a title matched it.
 */
const suggestShown = computed(() => suggestOpen.value && draft.value.trim().length >= SUGGEST_MIN_LENGTH)

const SUGGEST_LIST_ID = 'search-suggest'

function rowId(index: number): string {
  return `${SUGGEST_LIST_ID}-row-${index}`
}

function onTyped(value: string | number) {
  draft.value = String(value)
  activeRow.value = -1
  suggestOpen.value = true
  suggest(draft.value)
}

function closeSuggest() {
  suggestOpen.value = false
  activeRow.value = -1
}

/** Runs the search the box holds; a query is a URL parameter, so it shares. */
function submitSearch() {
  closeSuggest()
  clearSuggestions()
  const typed = draft.value.trim()
  if (typed === routeQuery.value) return
  // A new query starts at the first window.
  const { q: _replaced, page: _reset, ...rest } = route.query
  void router.push({ query: typed ? { ...rest, q: typed } : rest })
}

function openSuggestion(row: TitleSuggestion) {
  closeSuggest()
  clearSuggestions()
  void navigateTo(row.path)
}

function moveRow(step: number) {
  if (!suggestShown.value) return
  const next = activeRow.value + step
  // Walking off either end lands back on the bare box, where Enter searches.
  activeRow.value = next < -1 ? rowCount.value - 1 : next >= rowCount.value ? -1 : next
}

function onEnter() {
  const row = suggestShown.value ? suggestions.value[activeRow.value] : undefined
  if (row) openSuggestion(row)
  else submitSearch()
}

// The types a page can be, from the same exposure contract the frontmatter
// form renders from, so the chip offers what a page can actually hold.
const { data: schema } = await useFetch<FrontmatterSchema>('/api/openkb/schema', {
  // The editor's key: the exposure contract is one payload, whichever surface
  // asked for it first.
  key: 'openkb-frontmatter-schema',
  default: (): FrontmatterSchema => ({}),
})
const typeOptions = computed(() => toFormModel(schema.value).find(field => field.key === 'type')?.options ?? [])

/** A type's label, falling back to the machine name the row carries. */
function typeName(type: string): string {
  return typeOptions.value.find(option => option.value === type)?.label ?? type
}

// Every space the session may read — the chrome's own list, under its key, so
// the chip costs no request of its own.
const { spaces } = useSpaces()

/**
 * One filter chip: the route parameter it writes, and what may be picked.
 *
 * `options` is the closed set a menu offers. The Author chip has none — an
 * account is found by typing, on the picker the frontmatter form uses.
 */
interface FilterChip {
  key: 'space' | 'author' | 'updated' | 'type'
  icon: string
  label: string
  /** What the chip reads, and its menu entry, with nothing picked. */
  any: { chip: string, clear: string }
  picked: string
  options: Array<{ value: string, label: string }>
}

const filterChips = computed<FilterChip[]>(() => [
  {
    key: 'space',
    icon: 'i-lucide-folder',
    label: 'Space',
    any: { chip: 'all', clear: 'All spaces' },
    picked: routeSpace.value,
    options: spaces.value.map(space => ({ value: space.slug, label: space.name })),
  },
  {
    key: 'author',
    icon: 'i-lucide-user',
    label: 'Author',
    any: { chip: 'anyone', clear: 'Anyone' },
    picked: routeAuthor.value,
    options: [],
  },
  {
    key: 'updated',
    icon: 'i-lucide-calendar',
    label: 'Updated',
    any: { chip: 'any time', clear: 'Any time' },
    picked: routeUpdated.value,
    options: Object.entries(UPDATED_RANGES).map(([value, range]) => ({ value, label: range.label })),
  },
  {
    key: 'type',
    icon: 'i-lucide-file-text',
    label: 'Type',
    any: { chip: 'all types', clear: 'All types' },
    picked: routeType.value,
    options: typeOptions.value,
  },
])

/**
 * What a chip reads beside its label: the pick, or the wording for none.
 *
 * A pick the options do not name — a filter the URL carries before the list
 * has arrived — reads as itself, never as the wording for no filter at all.
 */
function chipValue(chip: FilterChip): string {
  if (chip.picked === '') return chip.any.chip
  return chip.options.find(option => option.value === chip.picked)?.label ?? chip.picked
}

/** A chip's menu: every option, and one click back to all of them. */
function chipItems(chip: FilterChip): DropdownMenuItem[][] {
  return [
    [{
      label: chip.any.clear,
      icon: chip.picked ? undefined : 'i-lucide-check',
      onSelect: () => narrowTo(chip.key, ''),
    }],
    chip.options.map(option => ({
      label: option.label,
      icon: option.value === chip.picked ? 'i-lucide-check' : undefined,
      onSelect: () => narrowTo(chip.key, option.value),
    })),
  ]
}

// A different filter is a different result set, so it starts at the first
// window; `page` is otherwise kept, which is what paging within one needs.
function narrowTo(key: FilterChip['key'], value: string) {
  if (value === (route.query[key] ?? '')) return
  const { [key]: _replaced, page: _reset, ...rest } = route.query
  void router.push({ query: value ? { ...rest, [key]: value } : rest })
}

/** Whether the Author chip's picker is open. */
const authorOpen = ref(false)

/** What the Author picker searches: any account, no bundle. */
const AUTHOR_TARGET: FrontmatterReferenceTarget = { entityType: 'user', bundles: [] }

/** The route carries the name the picker shows, which is what a row stores. */
function pickAuthor(match: EntityRef | null) {
  authorOpen.value = false
  narrowTo('author', match?.label ?? '')
}

/** The filters in force, each read as its chip reads it. */
const activeFilters = computed(() => filterChips.value
  .filter(chip => chip.picked !== '')
  .map(chip => `${chip.label}: ${chipValue(chip)}`))

/** One link back to the same search with nothing narrowing it. */
const withoutFilters = computed(() => ({ query: routeQuery.value ? { q: routeQuery.value } : {} }))

// Both arms take the space: a search narrows by it, and so does the empty
// query's listing.
const searchParams = computed(() => ({
  q: routeQuery.value,
  page: routePage.value,
  space: routeSpace.value || undefined,
  type: routeType.value || undefined,
  author: routeAuthor.value || undefined,
  updated: routeUpdated.value || undefined,
}))

const { data: results, pending, error: searchError, refresh: retrySearch } = await useFetch<PageSearchResponse>('/api/kb/search', {
  query: searchParams,
  default: (): PageSearchResponse => ({ query: '', page: 0, pageSize: 10, total: null, hasMore: false, pages: [] }),
  watch: [searchParams],
})

const pages = computed(() => results.value?.pages ?? [])
// The excerpt runs are parsed off the answer, not on every render.
const rows = computed(() => pages.value.map(page => ({ page, excerpt: rowExcerptParts(page) })))
/** How many pages there are, where the read counts: the listing, not a search. */
const total = computed(() => results.value?.total ?? null)
/** Whether a further window follows this one. */
const hasNextPage = computed(() => results.value?.hasMore === true)
/** Why nothing was searched, where the query's own words were refused. */
const refused = computed(() => results.value?.refused ?? '')

function goToPage(next: number) {
  void router.push({ query: { ...route.query, page: next > 0 ? String(next) : undefined } })
}

// Only the result region carries a search failure, so the query box and the
// filters stay usable with what the user typed still in them.
const searchErrorStatus = computed(() => Number(searchError.value?.statusCode) || 503)
// A refused request is a state about the request: the route says what is
// wrong with it, and the state offers no retry. Only ErrorState's refused
// kind shows this, so an outage's own message never reaches a reader.
const searchErrorReason = computed(() => serverMessage(searchError.value) ?? '')

const crumbs = [
  { label: 'Search', icon: 'i-lucide-search' },
]

// The AI summary — its own conversation, on the same endpoint as the chat
// panel's.
const {
  chat: summaryChat,
  messages: summaryMessages,
  status: summaryStatus,
  error: summaryError,
  needsAuth: summaryNeedsAuth,
  clear: clearSummary,
} = useChatSession()

// A refused session is not retried away: the summary's error state points at
// the login page instead, as the chat panel's alert does.
const summaryLoginHref = computed(() =>
  summaryNeedsAuth.value
    ? backendUrl(useRuntimeConfig().public.drupalBaseUrl as string | undefined, '/user/login')
    : null,
)

const streamed = computed<UIMessage | undefined>(() =>
  [...summaryMessages.value].reverse().find(m => m.role === 'assistant'),
)

/** The answer on screen when a replacement was asked for. The SDK appends the
 *  new assistant message on the stream's start chunk, before any text, so the
 *  answer and its sources are read off this snapshot until the replacement
 *  streams. */
const replaced = ref<UIMessage | undefined>()

const lastAssistant = computed<UIMessage | undefined>(() =>
  streamed.value && textFor(streamed.value) ? streamed.value : replaced.value ?? streamed.value,
)
const reasoningParts = computed<ReasoningUIPart[]>(() =>
  streamed.value?.parts.filter(isReasoning) ?? [],
)
const summaryText = computed(() => lastAssistant.value ? textFor(lastAssistant.value) : '')
const summaryCitations = computed(() => lastAssistant.value ? citationsFor(lastAssistant.value) : [])
/** The same, minus the sources a row could not lead to. */
const summarySources = computed(() => lastAssistant.value ? linkedCitationsFor(lastAssistant.value) : [])
/** How the answer stands is published when a turn settles, so a replacement
 *  has none while it streams: the state row reads off the snapshot until the
 *  new turn has a grounding of its own. */
const summaryGrounding = computed(() =>
  (streamed.value ? groundingFor(streamed.value) : null)
  ?? (replaced.value ? groundingFor(replaced.value) : null),
)

const summaryPrompt = computed(() => {
  const q = routeQuery.value.trim()
  const titles = pages.value.slice(0, 5).map(p => `- "${p.title}" (${p.path})`).join('\n')
  return [
    `User search query: ${q || '(empty)'}.`,
    titles ? `Top hits:\n${titles}` : 'No hits yet.',
    'Write a 2-3 sentence summary that contextualises the results, with [n] citation chips referencing the seeded pages.',
  ].join('\n')
})

/** Which search a summary belongs to: the prompt carries the pages, so a new
 *  window makes it stale like a new query. */
let summarised: string | null = null

/** The SDK reports `ready` for the whole gap between a send and its first
 *  token, so the page tracks the turn it asked for itself. */
const summaryTurn = ref(false)
const summaryBusy = computed(() =>
  summaryTurn.value || summaryStatus.value === 'streaming' || summaryStatus.value === 'submitted',
)

let turn = 0

// `summaryError` already carries the failure. Only the latest turn clears the
// flag; a superseded one settles late.
function ask() {
  summarised = summaryPrompt.value
  const id = ++turn
  summaryTurn.value = true
  void summaryChat.sendMessage({ text: summaryPrompt.value })
    .catch(() => {})
    .finally(() => { if (id === turn) summaryTurn.value = false })
}

// Keeps the previous answer visible until the replacement streams. The thread
// stays at one exchange: the transport posts every message in it back.
function regenerate() {
  if (summaryBusy.value) return
  replaced.value = lastAssistant.value
  clearSummary()
  ask()
}

// Hands the question to the chat panel's composer, unsent.
function openInChat() {
  openChat(routeQuery.value.trim())
}

/** How long the prompt must stay unchanged before it is worth a turn. */
const SETTLED_MS = 600

/** Whether there is a pane to put an answer in. Only ask when the summary pane
 *  is actually rendered. */
const summaryWanted = computed(
  () => paneContent.value === 'summary' && !paneHidden.value && paneWide.value,
)

// One summary per search, held until that search has landed, since the prompt
// carries the hits.
function summariseIfDue() {
  if (!summaryWanted.value || pending.value) return
  if (!routeQuery.value.trim() || summaryPrompt.value === summarised) return
  // One thread per search: the pane shows the last answer.
  replaced.value = undefined
  clearSummary()
  ask()
}

// The debounce timer must not outlive the page.
const summariseWhenSettled = useDebounceFn(summariseIfDue, SETTLED_MS)
onScopeDispose(() => summariseWhenSettled.cancel())

/** A query the page loaded with is already settled, so it skips the
 *  debounce; a later one waits for its hits to land. */
let unasked = !!routeQuery.value.trim()

// Client-only: the debounce is a browser timer, and the server render has no
// pane to put an answer in.
onMounted(() => {
  // Waits for the pane, not for the debounce: the layout sets `wide` in its own
  // mounted hook, after this one.
  watch([summaryWanted, pending], () => {
    if (!unasked || !summaryWanted.value || pending.value) return
    unasked = false
    summariseIfDue()
  }, { immediate: true })

  watch([summaryPrompt, summaryWanted, pending], summariseWhenSettled)
})
</script>

<template>
  <ChromeAppNavbar :crumbs="crumbs" />

  <!-- With nothing searched for there is nothing to summarise, so the page
       asks for no pane at all. -->
  <ChromePageBody :pane="routeQuery.trim() ? 'summary' : undefined">
    <main id="main-content" tabindex="-1" class="mx-auto w-full max-w-[1100px] px-4 py-6 focus:outline-none sm:px-6 sm:py-8">
      <h1 class="mb-1 text-[24px] font-bold text-highlighted">
        Search
      </h1>
      <p class="mb-6 text-[13px] text-muted">
        Pages are matched by meaning and by the words they hold: a row is a page, opened on the section that matched best.
      </p>

      <!-- A combobox over the box: focus never leaves the field, so the
           highlighted row is announced through `aria-activedescendant`. The
           offers cost no embedding; the search itself runs on Enter. -->
      <div class="relative mb-3">
        <!-- `⌘K` from anywhere lands here: `useAppShortcuts` routes to this
             page and focuses this field by its test id. -->
        <UInput
          :model-value="draft"
          :placeholder="routeSpace ? 'Search this space…' : 'Search the knowledge base…'"
          icon="i-lucide-search"
          size="lg"
          class="w-full"
          aria-label="Search the knowledge base"
          role="combobox"
          :aria-expanded="suggestShown"
          :aria-controls="suggestShown ? SUGGEST_LIST_ID : undefined"
          :aria-activedescendant="suggestShown && activeRow >= 0 ? rowId(activeRow) : undefined"
          aria-autocomplete="list"
          autofocus
          data-testid="search-input"
          @update:model-value="onTyped"
          @keydown.enter.prevent="onEnter"
          @keydown.down.prevent="moveRow(1)"
          @keydown.up.prevent="moveRow(-1)"
          @keydown.esc.prevent="closeSuggest"
          @blur="closeSuggest"
        />

        <ul
          v-if="suggestShown"
          :id="SUGGEST_LIST_ID"
          role="listbox"
          aria-label="Pages whose title starts with what you typed"
          class="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-[10px] bg-elevated py-1 shadow-xl ring ring-accented"
          data-testid="search-suggest"
        >
          <li
            v-for="(row, index) in suggestions"
            :id="rowId(index)"
            :key="row.id || row.path"
            role="option"
            :aria-selected="activeRow === index"
            class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[13px]"
            :class="activeRow === index ? 'bg-accented' : ''"
            data-testid="search-suggest-row"
            @mousedown.prevent="openSuggestion(row)"
            @mouseenter="activeRow = index"
          >
            <UIcon :name="row.type ? 'i-lucide-file-text' : 'i-lucide-file'" class="size-3.5 shrink-0 text-dimmed" />
            <span class="truncate text-highlighted">
              <template v-for="(part, at) in row.parts" :key="at">
                <strong v-if="part.marked" class="font-semibold">{{ part.text }}</strong>
                <template v-else>{{ part.text }}</template>
              </template>
            </span>
            <span v-if="row.space" class="ml-auto shrink-0 text-[12px] text-muted">{{ row.space }}</span>
          </li>
          <li
            :id="rowId(suggestions.length)"
            role="option"
            :aria-selected="activeRow === suggestions.length"
            class="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[13px] text-toned"
            :class="[activeRow === suggestions.length ? 'bg-accented' : '', suggestions.length ? 'border-t border-accented' : '']"
            data-testid="search-suggest-run"
            @mousedown.prevent="submitSearch"
            @mouseenter="activeRow = suggestions.length"
          >
            <UIcon name="i-lucide-search" class="size-3.5 shrink-0 text-dimmed" />
            <span class="truncate">Search for “{{ draft.trim() }}”</span>
          </li>
        </ul>
      </div>

      <div class="mb-5 flex flex-wrap items-center gap-1.5">
        <template v-for="chip in filterChips" :key="chip.key">
          <!-- An account is not a closed set, so the Author chip opens a
               type-to-search field rather than a menu of everyone. -->
          <UPopover v-if="chip.key === 'author'" v-model:open="authorOpen">
            <KbSearchFilterChip
              :filter-key="chip.key"
              :icon="chip.icon"
              :label="chip.label"
              :value="chipValue(chip)"
              :picked="chip.picked !== ''"
            />
            <template #content>
              <div class="w-64 p-2">
                <EditorFrontmatterReferenceField
                  :model-value="null"
                  :reference="AUTHOR_TARGET"
                  :multiple="false"
                  placeholder="Find an author…"
                  autofocus
                  aria-label="Find an author"
                  data-testid="search-author-input"
                  @update:model-value="pickAuthor"
                />
                <UButton
                  v-if="chip.picked"
                  block
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  class="mt-1.5"
                  data-testid="search-author-clear"
                  @click="pickAuthor(undefined)"
                >
                  {{ chip.any.clear }}
                </UButton>
              </div>
            </template>
          </UPopover>

          <UDropdownMenu v-else :items="chipItems(chip)">
            <KbSearchFilterChip
              :filter-key="chip.key"
              :icon="chip.icon"
              :label="chip.label"
              :value="chipValue(chip)"
              :picked="chip.picked !== ''"
            />
          </UDropdownMenu>
        </template>
      </div>

      <section
        aria-label="Search results"
        class="rounded-[10px] bg-default px-4 py-4 shadow-[0_0_0_1px_var(--ui-border)] sm:px-5"
      >
        <ErrorState
          v-if="searchError"
          :status-code="searchErrorStatus"
          :reason="searchErrorReason"
          @retry="retrySearch"
        />
        <template v-else>
          <!-- What the result region currently says, announced on its own:
               the rows below it are too long to read out on every search. -->
          <div class="mb-4 flex flex-wrap items-center gap-1.5 text-[13px] text-muted" role="status">
            <span v-if="pending">Searching…</span>
            <template v-else>
              <!-- Only the listing counts: a search knows the window it
                   fetched and no more. -->
              <strong v-if="total !== null" class="text-highlighted" data-testid="search-total">
                {{ total }} page{{ total === 1 ? '' : 's' }}
              </strong>
              <strong v-else class="text-highlighted" data-testid="search-total">
                Pages matching "<em class="font-normal text-toned">{{ routeQuery }}</em>"
              </strong>
            </template>
          </div>

          <ul v-if="pages.length" class="flex flex-col" data-testid="search-results">
            <li
              v-for="{ page, excerpt } in rows"
              :key="page.id || page.path"
              class="border-b border-(--ui-border-muted) py-3 last:border-b-0"
            >
              <NuxtLink
                :to="rowLink(page)"
                class="flex items-start gap-3 rounded-md px-1.5 py-1 transition hover:bg-elevated"
              >
                <span class="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-elevated text-muted">
                  <UIcon name="i-lucide-file-text" class="size-3.5" />
                </span>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-1.5 text-[11.5px] text-muted">
                    <span class="truncate font-mono text-[11px]">{{ page.path }}</span>
                    <template v-if="page.space">
                      <span class="text-dimmed">·</span>
                      <span class="truncate" data-testid="search-row-space">{{ page.space }}</span>
                    </template>
                    <template v-if="page.type">
                      <span class="text-dimmed">·</span>
                      <span class="shrink-0" data-testid="search-row-type">{{ typeName(page.type) }}</span>
                    </template>
                    <template v-if="page.tags.length">
                      <span class="text-dimmed">·</span>
                      <span class="truncate" data-testid="search-row-tags">{{ page.tags.join(', ') }}</span>
                    </template>
                    <template v-if="page.changed">
                      <span class="text-dimmed">·</span>
                      <span class="shrink-0" data-testid="search-row-changed">{{ changedOn(page) }}</span>
                    </template>
                  </div>
                  <div class="mt-0.5 flex items-baseline justify-between gap-3">
                    <span class="text-[15px] font-semibold text-highlighted hover:text-primary">
                      {{ page.title }}
                    </span>
                    <!-- Nothing was ranked on a recency listing, so there is
                         no relevance to show. -->
                    <span
                      v-if="routeQuery"
                      class="font-mono text-[10.5px] text-dimmed"
                      :title="`relevance ${page.score.toFixed(2)}`"
                    >
                      {{ page.score.toFixed(2) }}
                    </span>
                  </div>
                  <p
                    v-if="excerpt.length"
                    class="mt-1 line-clamp-2 text-[13px] leading-[1.5] text-toned"
                  >
                    <!-- The index marks a matched word with a pair of
                         private-use characters; each run is interpolated,
                         never set as HTML. -->
                    <template v-for="(part, i) in excerpt" :key="i">
                      <mark v-if="part.marked" class="bg-transparent font-semibold text-highlighted">{{ part.text }}</mark>
                      <template v-else>{{ part.text }}</template>
                    </template>
                  </p>
                </div>
              </NuxtLink>

              <!-- The page's other matching sections, each landing on its own
                   block. The first is the excerpt above, so it is not repeated. -->
              <div v-if="page.sections.length > 1" class="mt-1 pl-[46px]">
                <p class="mb-1 text-[11.5px] font-medium text-muted">
                  {{ sectionsLabel(page) }}
                </p>
                <ul class="flex flex-col gap-0.5">
                  <li v-for="section in subSections(page)" :key="section.blockId || section.path">
                    <NuxtLink
                      :to="section.path"
                      class="flex items-baseline gap-2 rounded px-1.5 py-1 text-[12.5px] hover:bg-elevated"
                      data-testid="search-section-link"
                    >
                      <UIcon name="i-lucide-corner-down-right" class="size-3 shrink-0 self-center text-dimmed" />
                      <span class="truncate font-medium text-toned">
                        {{ sectionLabel(section, page) }}
                      </span>
                      <span class="min-w-0 flex-1 truncate text-muted">
                        <template v-for="(part, i) in excerptParts(section)" :key="i">
                          <mark v-if="part.marked" class="bg-transparent font-semibold text-toned">{{ part.text }}</mark>
                          <template v-else>{{ part.text }}</template>
                        </template>
                      </span>
                    </NuxtLink>
                  </li>
                </ul>
              </div>
            </li>
          </ul>

          <!-- An empty answer means neither clause of the query matched, so
               it is "nothing is about this", not a broken search. A filter is
               the other way to empty the page, so it is named and droppable. -->
          <div v-else-if="!pending" class="py-6 text-center" data-testid="search-no-matches" role="status">
            <p class="text-[14px] font-medium text-highlighted">
              <template v-if="routeQuery">
                No page matches "{{ routeQuery }}"<template v-if="activeFilters.length"> with these filters</template>
              </template>
              <template v-else>No pages</template>
            </p>
            <p v-if="refused" class="mt-1 text-[13px] text-muted" data-testid="search-refused">
              {{ refused }}
            </p>
            <template v-else-if="activeFilters.length">
              <p class="mt-1 text-[13px] text-muted" data-testid="search-active-filters">
                {{ activeFilters.join(' · ') }}
              </p>
              <NuxtLink
                :to="withoutFilters"
                class="mt-1 inline-block text-[13px] font-medium text-primary hover:underline"
                data-testid="search-clear-filters"
              >
                Clear the filters
              </NuxtLink>
            </template>
            <p v-else-if="routeQuery" class="mt-1 text-[13px] text-muted">
              Try fewer or different words — a page answers when it is about the question, or when it holds every word of it.
            </p>
            <p v-else class="mt-1 text-[13px] text-muted">
              Nothing published in the spaces you may read.
            </p>
            <!-- Nothing was asked, so there is no question to hand on. -->
            <UButton
              v-if="routeQuery"
              class="mt-3"
              size="xs"
              color="neutral"
              variant="soft"
              icon="i-lucide-message-square"
              @click="openInChat"
            >
              Ask the assistant instead
            </UButton>
          </div>

          <nav
            v-if="pages.length && (routePage > 0 || hasNextPage)"
            class="mt-4 flex items-center justify-center gap-4"
            aria-label="Result pages"
          >
            <UButton
              size="xs"
              color="neutral"
              variant="soft"
              icon="i-lucide-chevron-left"
              :disabled="routePage === 0"
              @click="goToPage(routePage - 1)"
            >
              Previous
            </UButton>
            <span class="text-[12px] text-muted">Page {{ routePage + 1 }}</span>
            <UButton
              size="xs"
              color="neutral"
              variant="soft"
              trailing-icon="i-lucide-chevron-right"
              :disabled="!hasNextPage"
              @click="goToPage(routePage + 1)"
            >
              Next
            </UButton>
          </nav>
        </template>
      </section>
    </main>
    <!-- The pane header names the surface, so the tile carries no title of its
         own. `agent-tile` marks the answer as written by an agent. -->
    <template #pane>
      <div data-test="ai-summary" class="agent-tile p-3 text-[12.5px] text-(--ui-text-toned)">
        <template v-if="lastAssistant">
          <div v-if="summaryStatus === 'streaming' && reasoningParts.length" class="mb-2 italic text-(--ui-text-muted)">
            {{ reasoningParts[reasoningParts.length - 1]?.text }}
          </div>

          <div
            class="ai-summary__answer okb-prose"
            data-test="ai-summary-answer"
          >
            <ComarkAnswer :text="summaryText" :citation-chips="summaryCitations" />
          </div>

          <ChatAnswerState
            surface="summary"
            :grounding="summaryGrounding"
            :cited="summaryCitations.length"
            :query="routeQuery.trim()"
            :error="summaryError"
            :login-href="summaryLoginHref"
            @rephrase="openInChat"
            @retry="regenerate"
          />

          <div
            v-if="summarySources.length"
            class="mt-2 flex flex-col gap-1"
            data-test="ai-summary-sources"
          >
            <NuxtLink
              v-for="c in summarySources"
              :key="c.n"
              :to="c.path"
              :aria-label="c.title || undefined"
              class="flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11.5px] hover:bg-(--ui-bg-elevated)"
            >
              <UIcon name="i-lucide-file-text" class="size-3 text-(--okb-agent-text)" />
              <span class="truncate font-medium">[{{ c.n }}] {{ c.title }}</span>
              <span class="ml-auto font-mono text-[10px] text-(--ui-text-dimmed)">{{ c.score.toFixed(2) }}</span>
            </NuxtLink>
          </div>

          <div class="mt-3 flex flex-wrap gap-1.5">
            <UButton
              size="xs"
              color="neutral"
              variant="soft"
              icon="i-lucide-message-square"
              @click="openInChat"
            >
              Open in chat
            </UButton>
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-lucide-refresh-cw"
              :loading="summaryBusy"
              @click="regenerate"
            >
              Re-generate
            </UButton>
          </div>
        </template>

        <!-- The turn failed before there was an answer, so the failure state is
             all the tile has to show. -->
        <ChatAnswerState
          v-else-if="summaryError"
          :grounding="null"
          :cited="0"
          :error="summaryError"
          :login-href="summaryLoginHref"
          @retry="regenerate"
        />

        <p v-else class="italic text-muted">
          Synthesising answer…
        </p>
      </div>
    </template>
  </ChromePageBody>
</template>
