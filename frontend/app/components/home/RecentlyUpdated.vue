<script setup lang="ts">
// Pages by last edit, newest first — the honest form of a "recent activity"
// feed while Drupal exposes no activity stream. Every row is a node the session
// may see, its space, and its own `changed` timestamp; no actors, no verbs, and
// nothing that needs an events table to be true.
import { absoluteDate, lastUpdatedLabel } from '#shared/utils/kb-meta'
import type { KbPageListItem } from '#shared/utils/kb-spaces'

withDefaults(defineProps<{
  pages: KbPageListItem[]
  /** Off inside one space, where every row names the same one. */
  showSpace?: boolean
}>(), { showSpace: true })

const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => { timer = setInterval(() => (now.value = Date.now()), 60_000) })
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <section v-if="pages.length" class="rounded-[12px] bg-default px-[18px] pb-3 pt-4 shadow-[0_0_0_1px_var(--ui-border)]">
    <header class="flex items-center gap-1.5 pb-3">
      <UIcon name="i-lucide-history" class="size-[14px] text-muted" />
      <span class="text-[14px] font-semibold tracking-[-0.005em] text-highlighted">
        Recently updated
      </span>
    </header>
    <ul class="m-0 flex list-none flex-col gap-1 p-0">
      <li v-for="page in pages" :key="page.path">
        <NuxtLink
          :to="page.path"
          class="flex items-baseline gap-3 rounded-md px-2 py-2 transition hover:bg-(--ui-bg-muted)"
        >
          <UIcon name="i-lucide-file-text" class="size-[13px] shrink-0 text-muted" aria-hidden="true" />
          <span
            data-testid="recent-page-title"
            class="min-w-0 truncate text-[13.5px] font-medium text-highlighted"
          >
            {{ page.title }}
          </span>
          <!-- Plain text, not a second link: nesting an anchor inside the row
               link is invalid, and the space is one click away in the sidebar.
               It yields below `sm` — three of these on one row leaves the title
               truncated to a syllable, and the title is the row. -->
          <span v-if="page.space && showSpace" class="hidden shrink-0 text-[11.5px] text-muted sm:inline">
            in {{ page.space.name }}
          </span>
          <span
            v-if="lastUpdatedLabel(page.changed || null, now)"
            class="ml-auto shrink-0 text-[11px] text-dimmed"
            :title="absoluteDate(page.changed || null) ?? undefined"
          >
            {{ lastUpdatedLabel(page.changed || null, now) }}
          </span>
        </NuxtLink>
      </li>
    </ul>
  </section>
</template>
