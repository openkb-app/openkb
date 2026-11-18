<script setup lang="ts">
/**
 * A Drupal account form on a centred card: sign in, password reset, the
 * one-time login and the password it leads to.
 *
 * Drupal renders the fields and the button into the default slot and decides
 * the outcome; its messages arrive with the re-rendered form.
 */
defineProps<{
  /** The card's heading. */
  title: string
  /** Where the form posts. */
  action: string
  /** Drupal's own form attributes. */
  attributes?: Record<string, unknown>
  /** The form's HTTP method. */
  method?: string
}>()

const { messages } = useKbCePage()
</script>

<template>
  <main class="flex min-h-svh items-center justify-center bg-(--okb-ground) px-6 py-10">
    <div class="w-full max-w-md rounded-(--okb-radius) bg-default p-8 shadow-[0_0_0_1px_var(--ui-border)]">
      <ChromeLogo class="mb-5" />
      <h1 class="mb-5 text-[20px] font-bold tracking-tight text-highlighted">
        {{ title }}
      </h1>
      <DrupalCeMessages :messages="messages" class="mb-4" />
      <form
        v-bind="attributes ?? {}"
        :method="method ?? 'post'"
        :action="action"
        class="drupal-form okb-auth-form"
      >
        <slot />
      </form>
      <slot name="after" />
    </div>
  </main>
</template>

<style scoped>
.okb-auth-form :deep(input:is([type='text'], [type='password'], [type='email'])) {
  max-width: none;
}

.okb-auth-form :deep(p) {
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--ui-text-toned);
}

/* The card's one action. */
.okb-auth-form :deep(.form-actions :is(input[type='submit'], button)) {
  width: 100%;
  border-color: var(--ui-primary);
  background: var(--ui-primary);
  color: var(--ui-text-inverted);
}

.okb-auth-form :deep(.form-actions :is(input[type='submit'], button):hover) {
  background: var(--okb-primary-hover);
}
</style>
