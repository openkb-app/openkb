<script setup lang="ts">
import type { NuxtError } from '#app'

/**
 * Full-page error boundary. Replaces Nuxt's default screen — which prints the
 * failing request method, URL and framework message — with the branded state.
 *
 * The 5xx retry re-runs the failed navigation rather than only clearing the
 * error: a transient backend outage is the common case and a plain
 * `clearError()` would re-render the same broken route from cache.
 */
const props = defineProps<{ error: NuxtError }>()

const status = computed(() => {
  const code = Number(props.error?.statusCode) || 500
  // Anything the app could not classify is an outage from the reader's side.
  return [401, 403, 404].includes(code) ? code : (code >= 500 ? code : 500)
})

function retry() {
  clearError({ redirect: useRoute().fullPath })
}

// Nuxt renders this boundary in place of `app.vue`, so the `titleTemplate`
// there never runs and the pattern is written out here.
useHead({
  title: () => {
    const code = status.value
    if (code === 404) return 'Page not found · OpenKnowledgebase'
    if (code === 401 || code === 403) return 'No access · OpenKnowledgebase'
    return 'Temporarily unavailable · OpenKnowledgebase'
  },
})
</script>

<template>
  <ErrorState :status-code="status" full-page @retry="retry" />
</template>
