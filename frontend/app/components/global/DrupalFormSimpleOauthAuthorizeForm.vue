<script setup lang="ts">
/**
 * The OAuth consent screen, as this app renders it.
 *
 * A `drupal-form-*` custom element like any other: simple_oauth's own form —
 * CSRF token, hidden fields, the agent-name field and both buttons — arrives in
 * the default slot and posts straight back, so deciding works with JavaScript
 * off. The props are facts `openkb_agent`'s form alter put there; nothing is
 * decided here.
 */
const props = defineProps<{
  /** The client asking, as it is registered. */
  client: string
  /** What approving allows, in words the person can act on. */
  scopes: { name: string, description: string }[]
  /** Where deciding sends the browser, either way. */
  callback: string
  /** Drupal's own form attributes. */
  attributes?: Record<string, unknown>
  method: string
}>()

/**
 * Posted back to the URL the screen was served on, read off the request rather
 * than rebuilt from the route: the query string is what Drupal validates and
 * what the issued code is bound to, so it returns byte for byte.
 */
const action = useRequestURL().href

useHead({ title: `Authorize ${props.client}` })

const consentForm = ref<HTMLFormElement | null>(null)

/**
 * Keeps the name field's description saying what the typed name would do.
 *
 * The line is Drupal's, rendered with the pre-filled name; only the name in it
 * is refreshed, so the screen reads the same with scripting off.
 */
onMounted(() => {
  const input = consentForm.value?.querySelector<HTMLInputElement>('input[name="agent_name"]')
  const shown = consentForm.value?.querySelector<HTMLElement>('[data-okb-agent-name]')
  if (!input || !shown) {
    return
  }
  input.addEventListener('input', () => {
    shown.textContent = input.value.trim() || input.defaultValue
  })
})
</script>

<template>
  <main class="flex min-h-svh items-center justify-center bg-(--okb-ground) px-6 py-10">
    <div class="w-full max-w-lg rounded-(--okb-radius) bg-default p-8 shadow-[0_0_0_1px_var(--ui-border)]">
      <ChromeLogo class="mb-5" />

      <h1 class="mb-4 text-[20px] font-bold tracking-tight text-highlighted">
        Allow <span data-testid="consent-client">{{ client }}</span> to use OpenKnowledgebase
      </h1>

      <h2 class="mb-2 text-[13px] font-semibold tracking-tight text-highlighted">
        What it will be allowed to do
      </h2>
      <ul
        v-if="scopes.length"
        data-testid="consent-scopes"
        class="mb-5 flex flex-col gap-1.5"
      >
        <li
          v-for="scope in scopes"
          :key="scope.name"
          class="flex items-start gap-2 text-[13.5px] leading-relaxed text-toned"
        >
          <UIcon name="i-lucide-check" class="mt-1 size-4 shrink-0 text-(--color-success-600)" />
          <span>{{ scope.description || scope.name }}</span>
        </li>
      </ul>
      <p v-else class="mb-5 text-[13.5px] leading-relaxed text-toned">
        Nothing at all — the request names no access.
      </p>

      <p v-if="callback" class="mb-1 text-[11.5px] text-muted">
        Either way you are sent back to
        <code class="font-mono break-all">{{ callback }}</code>.
      </p>

      <form
        ref="consentForm"
        v-bind="attributes ?? {}"
        :method="method"
        :action="action"
        class="okb-consent"
      >
        <slot />
      </form>
    </div>
  </main>
</template>

<style scoped>
/* The form items and buttons come from Drupal, so they carry Drupal's markup
   and none of this app's utility classes. openkb_agent marks the two buttons;
   everything else here is the frontend's own look. */
.okb-consent :deep(.form-item) {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  margin-top: 1.25rem;
}

.okb-consent :deep(.form-item label) {
  font-size: 13px;
  font-weight: 600;
  color: var(--ui-text-highlighted);
}

.okb-consent :deep(input[type="text"]) {
  width: 100%;
  border: 1px solid var(--ui-border-accented);
  border-radius: 8px;
  background: var(--ui-bg);
  padding: 0.5rem 0.75rem;
  font-size: 13.5px;
  color: var(--ui-text-highlighted);
}

.okb-consent :deep(input[type="text"]:focus-visible) {
  outline: 2px solid var(--ui-primary);
  outline-offset: 1px;
}

.okb-consent :deep(.description) {
  font-size: 12px;
  line-height: 1.5;
  color: var(--ui-text-muted);
}

.okb-consent :deep(.form-actions) {
  display: flex;
  gap: 0.5rem;
  margin-top: 1.25rem;
}

.okb-consent :deep(input[type="submit"]),
.okb-consent :deep(button[type="submit"]) {
  cursor: pointer;
  border-radius: 8px;
  padding: 0.5rem 1rem;
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.25rem;
}

.okb-consent :deep(.okb-consent-allow) {
  flex: 1;
  border: 1px solid var(--ui-primary);
  background: var(--ui-primary);
  color: var(--ui-text-inverted);
}

.okb-consent :deep(.okb-consent-deny) {
  border: 1px solid var(--ui-border-accented);
  background: transparent;
  color: var(--ui-text-toned);
}
</style>
