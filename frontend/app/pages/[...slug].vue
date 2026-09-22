<script setup lang="ts">
/**
 * The generic Custom-Elements fallback, as nuxtjs-drupal-ce designs it: it
 * fetches whatever the route resolves to and renders it one component per
 * element, resolved by name at runtime. It owns no content shape of its own —
 * a page renders through `NodeKbPage`, a history through
 * `NodeRevisionHistory`, each of which brings its own navbar and `<main>`.
 */
const route = useRoute()
const { fetchPage, renderCustomElementsToVNodes } = useDrupalCe()

if (route.path.startsWith('/api/')) {
  throw createError({ statusCode: 404, statusMessage: 'Not found' })
}

// The query goes to Drupal with the path, as it does in the Lupus Decoupled
// starter's catch-all: some routes this page serves are answered *by* their
// query rather than decorated with it. `/user/logout?token=…` — the account
// menu's own sign-out link — is refused outright without the CSRF token it
// carries, so a path-only fetch turns signing out into a 403.
//
// The module's default handler rethrows the ofetch message verbatim
// (`[GET] "/api/drupal-ce/…": 500 …`), which then rides into the client
// payload. Replace it with a status-only error: app/error.vue derives all
// user-facing copy from the status class anyway.
const page = await fetchPage(route.path, { query: route.query }, (error) => {
  const statusCode = Number(error.value?.statusCode) || 503
  console.error(`[kb-page] ${route.path} → ${statusCode}: ${error.value?.message ?? ''}`)
  throw createError({
    statusCode,
    statusMessage: statusCode === 404 ? 'Not found' : 'Page unavailable',
    fatal: true,
  })
})

if (!page.value?.content) {
  throw createError({ statusCode: 404, statusMessage: 'Not found' })
}


// Re-fetch the enriched CE page and reseat it so the read view renders what a
// session left in Drupal — the payload fetched at page load is stale after a
// save. Only the fetch owner can do this: a CE component receives its element's
// props and slots, not the page wrapper the body slot is bound to. A failed
// refresh keeps the current payload; the reader can still reload.
async function refresh() {
  try {
    const fresh = await $fetch<typeof page.value>(`/api/drupal-ce${route.path}`)
    if (fresh?.content) page.value = { ...fresh, key: page.value.key }
  }
  catch (err) {
    console.error('[kb-page] post-edit refresh failed:', err)
  }
}
provideKbCePage(page, refresh)

// One component per element, resolved by name — the page, a history, or any
// other CE payload, rendered through the same renderer with no branch here.
//
// A stable wrapper that builds FRESH vnodes from the current payload each
// render: the module's array `renderCustomElements` returns a component that
// re-serves one pre-built vnode array, and reusing mounted vnodes remounts this
// subtree on an unrelated re-render (a hash navigation) — which drops the focus
// a skip link had just moved into `#main-content`. A component whose identity is
// fixed and whose render reads `page.value.content` reseats after a save and
// survives navigation without remounting.
const CeContent = defineComponent({
  name: 'CeContent',
  setup() {
    return () => renderCustomElementsToVNodes([page.value.content])
  },
})

// The window/tab title names the page, not the app — titling from the payload
// here covers every CE-routed page off one line. app.vue appends the product
// name; a payload that carries no title leaves it to say the product alone.
useHead(() => ({
  title: page.value?.title ?? '',
}))
</script>

<template>
  <!-- Keyed on the path so navigating between pages remounts a fresh editor
       session instead of reseating a live one. A hash change keeps the path, so
       the skip link's jump into `#main-content` does not remount the surface. -->
  <component :is="CeContent" :key="route.path" />
</template>
