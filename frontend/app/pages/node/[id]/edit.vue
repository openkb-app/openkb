<script setup lang="ts">
// The read page hosts the editor in place; this route only resolves the
// node's path and forwards there with ?edit, which starts the editor preload
// after the read view mounts.
const route = useRoute()
const nid = Number(route.params.id)
if (!nid || !Number.isFinite(nid)) {
  throw createError({ statusCode: 400, statusMessage: 'Invalid node id', fatal: true })
}

// Only the path alias is needed here, and it is the same on every revision —
// so ask for the default revision. The working copy would demand
// draft-visibility access, and this route must keep redirecting for a reader
// who has none: the gating message belongs on the read page, not here.
// `useRequestFetch`, not a bare `$fetch`: on the server the lookup has to carry
// the visitor's session, or it resolves anonymously — and an anonymous session
// reads nothing inside a space, so every edit link would 404.
const requestFetch = useRequestFetch()
const { data: page, error } = await useAsyncData(
  `edit-redirect:${nid}`,
  () => requestFetch<{ path: string }>(`/api/node/${nid}?version=default`),
)
if (error.value || !page.value?.path) {
  const status = Number((error.value as { statusCode?: number } | null)?.statusCode) || 404
  throw createError({ statusCode: status, statusMessage: 'Page not found', fatal: true })
}

await navigateTo({ path: page.value.path, query: { edit: '' } }, { replace: true, redirectCode: 302 })
</script>

<template>
  <div />
</template>
