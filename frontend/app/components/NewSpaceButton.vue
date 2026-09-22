<script setup lang="ts">
/**
 * The "New space" trigger (OKB-131) — a real button that opens the create
 * dialog, and only that. The dialog is {@link Dialog}; splitting them
 * keeps this to the affordance: a labelled `<button>` (UButton) with the app's
 * focus ring, operable by keyboard, that reads as a button in every placement.
 *
 * Rendered only where the session may create a space — the callers gate it on
 * `canCreateSpace`, so the button is absent rather than a dead end. Drupal still
 * decides the write.
 */
const props = defineProps<{
  label?: string
  size?: 'xs' | 'sm' | 'md'
  color?: 'primary' | 'neutral'
  variant?: 'solid' | 'outline' | 'soft' | 'subtle'
}>()

const open = ref(false)

// The dialog teleports to the body, so it survives a popover (the sidebar
// switcher) unmounting its content on the outside click that opening it is.

// This button is rendered inside the collapsed sidebar rail, which stays
// expanded — and so mounted — while the dialog is open.
useRailHold(open)
</script>

<template>
  <UButton
    :color="props.color ?? 'neutral'"
    :variant="props.variant ?? 'outline'"
    :size="props.size ?? 'sm'"
    icon="i-lucide-folder-plus"
    aria-haspopup="dialog"
    data-testid="new-space-cta"
    @click="open = true"
  >
    {{ props.label ?? 'New space' }}
  </UButton>
  <SpaceDialog v-model:open="open" />
</template>
