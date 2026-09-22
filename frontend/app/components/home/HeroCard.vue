<script setup lang="ts">
// Home hero: what this knowledge base is, how big it actually is, and the two
// actions that work today — create a page, ask the AI about the KB.
//
// The counts are passed in from the home page's own `/api/kb` and `/api/spaces`
// reads, so the hero states nothing the backend cannot confirm. Space identity
// (a named space, its members, its visibility) belongs to the space's page,
// which reads a real space; the home page is the whole KB and does not pretend
// to be one space.

const props = defineProps<{
  spaceCount: number
  pageCount: number
}>()

const { toggleChat } = useSidePane()

// No space in context here, so any space the session may write is enough.
const canCreatePage = useCanCreatePage(null)

const counts = computed(() => [
  `${props.pageCount} ${props.pageCount === 1 ? 'page' : 'pages'}`,
  `${props.spaceCount} ${props.spaceCount === 1 ? 'space' : 'spaces'}`,
].join(' · '))
</script>

<template>
  <section
    class="rounded-(--okb-radius) bg-default px-6 py-5 shadow-[0_0_0_1px_var(--ui-border)]"
  >
    <div class="mb-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-5">
      <div class="min-w-0 flex-1">
        <div class="mb-2.5 min-w-0">
          <div class="text-[28px] font-semibold leading-[1.1] tracking-[-0.03em] text-highlighted">
            <span class="font-normal">Open</span>Knowledgebase
          </div>
          <div class="mt-0.5 font-mono text-[12.5px] text-muted">
            {{ counts }}
          </div>
        </div>
        <p class="m-0 max-w-[70ch] text-[14.5px] leading-[1.6] text-toned">
          Markdown pages, collaboratively edited, readable by people and by
          agents through the same store.
        </p>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2 border-t border-(--ui-border-muted) pt-4">
      <!-- No space context on the home hero (the space shown here is still a
           design placeholder), so the dialog asks which space to create in. -->
      <NewPageButton v-if="canCreatePage" />
      <UButton
        color="primary"
        variant="solid"
        size="sm"
        icon="i-lucide-sparkles"
        @click="toggleChat()"
      >
        Ask AI
      </UButton>
      <UButton
        color="neutral"
        variant="ghost"
        size="sm"
        icon="i-lucide-search"
        to="/search"
      >
        Search
      </UButton>
    </div>
  </section>
</template>
