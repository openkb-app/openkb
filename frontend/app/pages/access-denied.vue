<script setup lang="ts">
// Reached when the global auth middleware sees no Drupal session cookie.
// Anonymous users get this; everything else is locked.
definePageMeta({ layout: false, middleware: [] })
const route = useRoute()
const loginHref = computed(() => {
  const next = route.query.from ? String(route.query.from) : '/'
  return `/user/login?destination=${encodeURIComponent(next)}`
})
</script>

<template>
  <main class="flex min-h-svh items-center justify-center bg-(--okb-ground) px-6">
    <div class="w-full max-w-md rounded-(--okb-radius) bg-default p-8 shadow-[0_0_0_1px_var(--ui-border)]">
      <ChromeLogo class="mb-5" />
      <h1 class="mb-2 text-[20px] font-bold tracking-tight text-highlighted">
        Sign in to continue
      </h1>
      <p class="mb-5 text-[13.5px] leading-relaxed text-toned">
        OpenKnowledgebase requires a logged-in account. Sign in to access the knowledge base.
      </p>
      <UButton
        :to="loginHref"
        color="primary"
        size="md"
        block
        icon="i-lucide-log-in"
      >
        Sign in
      </UButton>
    </div>
  </main>
</template>
