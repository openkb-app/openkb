<script setup lang="ts">
/**
 * Drupal's accept page for an invite onto a space, on a sign-in card. Accepting
 * puts the invitee on the roster and opens the space.
 */
defineProps<{
  /** Drupal's own form attributes. */
  attributes?: Record<string, unknown>
  /** The form's HTTP method. */
  method?: string
}>()

const { title } = useKbCePage()
const action = useRoute().fullPath

useHead({ title })
</script>

<template>
  <ChromeAuthCard :title="title" :action="action" :attributes="attributes" :method="method">
    <slot />
  </ChromeAuthCard>
</template>
