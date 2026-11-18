<script setup lang="ts">
/**
 * Drupal's account form, on a sign-in card. The frontend serves it after a
 * one-time login, where Drupal asks only for the new password.
 */
defineProps<{
  /** Drupal's own form attributes. */
  attributes?: Record<string, unknown>
  method?: string
}>()

const { title } = useKbCePage()
// Posts back with the one-time login's token, which waives the current password.
const action = useRoute().fullPath

useHead({ title })
</script>

<template>
  <ChromeAuthCard :title="title" :action="action" :attributes="attributes" :method="method">
    <slot />
  </ChromeAuthCard>
</template>
