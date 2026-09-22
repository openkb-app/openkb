<script setup lang="ts">
/**
 * Drupal's messages for the current CE page.
 *
 * Rendered where the page they belong to renders them, not in the app chrome:
 * these arrive with a page render, and the one that matters most — the
 * one-time secret of a freshly created API client — is only ever shown once.
 * The text is Drupal-rendered HTML (`<code>`, placeholder emphasis), so it goes
 * in as markup — at full opacity, and in body text rather than the alert's own
 * colour, which does not clear the contrast floor against its tint
 * (`.drupal-message-body` in main.css).
 */
import type { DrupalMessage } from '#shared/utils/drupal-messages'

defineProps<{ messages: DrupalMessage[] }>()

const COLORS = { error: 'error', warning: 'warning', success: 'success' } as const
const ICONS = {
  error: 'i-lucide-circle-alert',
  warning: 'i-lucide-triangle-alert',
  success: 'i-lucide-circle-check',
} as const
</script>

<template>
  <div v-if="messages.length" class="flex flex-col gap-2" data-testid="drupal-messages">
    <UAlert
      v-for="(message, index) in messages"
      :key="`${message.kind}-${index}`"
      :color="COLORS[message.kind]"
      :icon="ICONS[message.kind]"
      variant="soft"
      :data-kind="message.kind"
      :ui="{ description: 'opacity-100' }"
    >
      <template #description>
        <div class="drupal-message-body" v-html="message.html" />
      </template>
    </UAlert>
  </div>
</template>
