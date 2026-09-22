<script setup lang="ts">
/**
 * Branded failure state, shared by the full-page error boundary (app/error.vue)
 * and by inline regions that fail on their own (search results, editor load).
 *
 * Copy is derived from the status *class* only, with one exception: a refused
 * request may be handed the reason it was refused, which is written for the
 * reader. Proxy paths, upstream bodies and framework stack text are never
 * surfaced — they name internal infrastructure and give a reader nothing to
 * act on. The numeric status rides along as a `data-status` attribute so E2E
 * can assert the mapping without it being visible chrome.
 */
const props = withDefaults(defineProps<{
  /** Status the app decided on: 404, 403/401, another 4xx, or 5xx. */
  statusCode?: number
  /** Renders the standalone centred card instead of an inline panel. */
  fullPage?: boolean
  /** Hides the retry action where a retry cannot help (e.g. a hard 404). */
  retryable?: boolean
  /** Why a refused request was refused, in the words the route answered. */
  reason?: string
}>(), {
  statusCode: 500,
  fullPage: false,
  retryable: true,
  reason: '',
})

const emit = defineEmits<{ retry: [] }>()

type Kind = 'not-found' | 'forbidden' | 'refused' | 'unavailable'

const kind = computed<Kind>(() => {
  if (props.statusCode === 404) return 'not-found'
  if (props.statusCode === 401 || props.statusCode === 403) return 'forbidden'
  if (props.statusCode >= 400 && props.statusCode < 500) return 'refused'
  return 'unavailable'
})

const copy = computed(() => ({
  'not-found': {
    icon: 'i-lucide-file-question',
    title: 'This page doesn’t exist',
    description: 'The page you’re looking for was moved, renamed, or never existed. It may also be restricted to another space.',
  },
  'forbidden': {
    icon: 'i-lucide-lock',
    title: 'You don’t have access',
    description: 'This page needs a signed-in account with access to it. Sign in and try again.',
  },
  'refused': {
    icon: 'i-lucide-circle-slash',
    title: 'This request cannot be run',
    description: props.reason || 'Something in what was asked for is not allowed here. Change it and try again.',
  },
  'unavailable': {
    icon: 'i-lucide-cloud-off',
    title: 'OpenKnowledgebase is temporarily unavailable',
    description: 'We couldn’t reach the knowledge base just now. Nothing you did caused this — please try again in a moment.',
  },
}[kind.value]))

const route = useRoute()
const loginHref = computed(() => `/user/login?destination=${encodeURIComponent(route.fullPath)}`)
const showRetry = computed(() => props.retryable && kind.value === 'unavailable')
</script>

<template>
  <div
    data-testid="error-state"
    :data-status="statusCode"
    :data-kind="kind"
    :class="fullPage
      ? 'flex min-h-svh items-center justify-center bg-(--okb-ground) px-6'
      : 'flex items-center justify-center px-6 py-12'"
  >
    <div
      class="w-full max-w-md rounded-[14px] bg-default p-8 text-center shadow-[0_0_0_1px_var(--ui-border)]"
    >
      <span class="mx-auto mb-4 inline-flex size-11 items-center justify-center rounded-full bg-elevated">
        <UIcon :name="copy.icon" class="size-5 text-toned" />
      </span>

      <h1 class="mb-2 text-[20px] font-bold tracking-tight text-highlighted">
        {{ copy.title }}
      </h1>
      <p class="mb-6 text-[13.5px] leading-relaxed text-toned">
        {{ copy.description }}
      </p>

      <div class="flex flex-col gap-2">
        <UButton
          v-if="showRetry"
          data-testid="error-retry"
          color="primary"
          size="md"
          block
          icon="i-lucide-refresh-cw"
          @click="emit('retry')"
        >
          Try again
        </UButton>
        <UButton
          v-if="kind === 'forbidden'"
          :to="loginHref"
          color="primary"
          size="md"
          block
          icon="i-lucide-log-in"
        >
          Sign in
        </UButton>
        <UButton
          to="/"
          :color="showRetry || kind === 'forbidden' ? 'neutral' : 'primary'"
          :variant="showRetry || kind === 'forbidden' ? 'outline' : 'solid'"
          size="md"
          block
          icon="i-lucide-home"
        >
          Back to the knowledge base
        </UButton>
        <UButton
          v-if="kind === 'not-found'"
          to="/search"
          color="neutral"
          variant="ghost"
          size="md"
          block
          icon="i-lucide-search"
        >
          Search instead
        </UButton>
      </div>
    </div>
  </div>
</template>
