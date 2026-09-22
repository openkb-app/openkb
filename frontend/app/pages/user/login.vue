<script setup lang="ts">
// Frontend-rendered login form. Posts to /api/login which forwards the
// credentials to Drupal's JSON login endpoint and relays the Set-Cookie
// (parent-domain-scoped SESS cookie). On success, redirects to the
// destination query param or /.
definePageMeta({
  layout: false,
  // Bypass the global auth middleware on the login page itself.
  middleware: [],
})

const route = useRoute()
const name = ref('')
const pass = ref('')
const submitting = ref(false)
const error = ref<string | null>(null)
// Drives the alert's icon/colour and gives E2E a stable hook for asserting
// that a dead backend and a rejected password read differently.
const errorKind = ref<'credentials' | 'unavailable' | 'unknown' | null>(null)

async function submit() {
  if (!name.value || !pass.value || submitting.value) return
  submitting.value = true
  error.value = null
  errorKind.value = null
  try {
    await $fetch('/api/login', {
      method: 'POST',
      body: { name: name.value, pass: pass.value },
    })
    const next = route.query.destination ? String(route.query.destination) : '/'
    // Full reload so SSR picks up the new cookie on the first paint.
    window.location.assign(next)
  }
  catch (e: unknown) {
    const err = e as { statusCode?: number, response?: { status?: number } }
    const status = err?.statusCode ?? err?.response?.status
    // 503 means the backend is unreachable — telling the user their password
    // is wrong there would send them retrying a credential that is fine.
    error.value = status === 401
      ? 'Invalid username or password.'
      : status === 503
        ? 'OpenKnowledgebase is temporarily unavailable. Your credentials were not checked — please try again in a moment.'
        : 'Sign-in failed. Please try again.'
    errorKind.value = status === 401 ? 'credentials' : status === 503 ? 'unavailable' : 'unknown'
    submitting.value = false
  }
}
</script>

<template>
  <main class="flex min-h-svh items-center justify-center bg-(--okb-ground) px-6">
    <div class="w-full max-w-md rounded-(--okb-radius) bg-default p-8 shadow-[0_0_0_1px_var(--ui-border)]">
      <ChromeLogo class="mb-5" />
      <h1 class="mb-1 text-[20px] font-bold tracking-tight text-highlighted">
        Sign in
      </h1>
      <p class="mb-5 text-[13.5px] leading-relaxed text-toned">
        Enter your OpenKnowledgebase credentials to continue.
      </p>

      <UAlert
        v-if="error"
        data-testid="login-error"
        :data-kind="errorKind"
        :color="errorKind === 'unavailable' ? 'warning' : 'error'"
        variant="soft"
        :description="error"
        :icon="errorKind === 'unavailable' ? 'i-lucide-cloud-off' : 'i-lucide-alert-circle'"
        class="mb-4"
      />

      <form class="flex flex-col gap-3" @submit.prevent="submit">
        <UFormField label="Username" name="name" required>
          <UInput
            v-model="name"
            type="text"
            autocomplete="username"
            autofocus
            size="md"
            placeholder="admin"
            class="w-full"
          />
        </UFormField>
        <UFormField label="Password" name="pass" required>
          <UInput
            v-model="pass"
            type="password"
            autocomplete="current-password"
            size="md"
            class="w-full"
          />
        </UFormField>
        <UButton
          type="submit"
          color="primary"
          size="md"
          :loading="submitting"
          :disabled="!name || !pass"
          block
          icon="i-lucide-log-in"
        >
          Sign in
        </UButton>
      </form>

      <p class="mt-5 text-[11.5px] text-muted">
        For password reset use the Drupal admin path.
      </p>
    </div>
  </main>
</template>
