<script setup lang="ts">
/**
 * Drupal's login form, on a sign-in card. Also serves the password reset form.
 *
 * A wrong password or a flood block (the `user-form-flood-error` patch)
 * arrives with the re-rendered form.
 */
defineProps<{
  /** Drupal's own form attributes. */
  attributes?: Record<string, unknown>
  method?: string
}>()

const { title } = useKbCePage()
const route = useRoute()

const isReset = route.path === '/user/password'

// - Login: without a destination, Drupal sends a signed-in user to their account page.
// - Reset: the login card shows Drupal's confirmation; other pages' renders consume it unseen.
const action = isReset
  ? `${route.path}?destination=/user/login`
  : route.query.destination ? route.fullPath : `${route.path}?destination=/`

const other = isReset
  ? { to: '/user/login', label: 'Back to log in' }
  : { to: '/user/password', label: 'Forgot your password?' }

useHead({ title })
</script>

<template>
  <ChromeAuthCard :title="title" :action="action" :attributes="attributes" :method="method">
    <slot />
    <template #after>
      <ULink :to="other.to" class="okb-other mt-5 inline-block text-[13px] text-toned underline hover:text-highlighted">
        {{ other.label }}
      </ULink>
    </template>
  </ChromeAuthCard>
</template>

<style scoped>
/* A wrong password or an account flood block (`user-form-flood-error` patch)
   carries Drupal's own reset link; the card's link would repeat it. */
:deep(.okb-auth-form:has(a[href^='/user/password']) + .okb-other) {
  display: none;
}
</style>
