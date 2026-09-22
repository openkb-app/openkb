<script setup lang="ts">
// The `node-revision-history` element, served by the CE route at
// /node/{node}/revisions. Global and named after the element: that is how the
// CE renderer finds a component for a payload it knows nothing about. This one
// owns the frame, `NodeRevision` owns a row.
import { historyScope } from '~/utils/revision-history'

const props = defineProps<{
  /** The node this is the history of. */
  nid?: number
  title?: string
  /** Back to the node — Drupal's alias, not a slug reassembled here. */
  nodeUrl?: string
  /** Every revision it has, including the ones past the page window. */
  total?: number
  /** How many of them this response describes. */
  shown?: number
}>()

const scope = computed(() => historyScope(props.shown ?? 0, props.total ?? 0))
</script>

<template>
  <!-- Own navbar and <main>: the CE catch-all is generic and renders no chrome,
       so each element brings its own. A bare titled header names the page
       whose history this is; the payload's own "Back to the page" link below
       is the way back. -->
  <ChromeAppNavbar :title="title" />
  <ChromePageBody>
    <main id="main-content" tabindex="-1" class="focus:outline-none">
      <section class="mx-auto w-full max-w-3xl px-4 py-6">
      <header class="mb-4 border-b border-default pb-4">
        <h1 class="text-xl font-semibold text-highlighted">
          Version history
        </h1>
        <p v-if="title" class="mt-1 text-sm text-muted">
          {{ title }}
        </p>
        <p v-if="scope" class="mt-2 text-[12.5px] text-dimmed" data-testid="revision-history-scope">
          {{ scope }}
        </p>
        <NuxtLink
          v-if="nodeUrl"
          :to="nodeUrl"
          class="mt-3 inline-flex items-center gap-1 text-sm text-muted underline underline-offset-2 hover:text-highlighted"
          data-testid="revision-history-back"
        >
          <UIcon name="i-lucide-arrow-left" class="size-3.5" aria-hidden="true" />
          Back to the page
        </NuxtLink>
      </header>

      <!-- Newest first, as Drupal sent it. Nothing here reorders or filters — a
           row missing from this page is a row Drupal did not serve. -->
      <ol class="divide-y divide-default" data-testid="revision-history-list">
        <slot name="revisions" />
      </ol>
      </section>
    </main>
  </ChromePageBody>
</template>
