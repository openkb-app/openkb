<script setup lang="ts">
/**
 * Drupal's one-time login form, on a sign-in card: an invitee's welcome, or a
 * password reset's confirmation.
 */
const props = defineProps<{
  /** The form's heading. */
  title?: string
  /** The one-time login URL the button posts to. */
  action: string
  /** Drupal's own form attributes. */
  attributes?: Record<string, unknown>
  method?: string
}>()

const { title: pageTitle } = useKbCePage()
const heading = computed(() => props.title || pageTitle.value)

useHead({ title: heading })
</script>

<template>
  <ChromeAuthCard :title="heading" :action="action" :attributes="attributes" :method="method">
    <slot />
  </ChromeAuthCard>
</template>
