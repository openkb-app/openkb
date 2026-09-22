<script setup lang="ts">
/**
 * The button one search filter is picked from.
 *
 * Only the button: what opens under it is the caller's — a menu for a closed
 * set of options, a type-to-search field for the authors.
 */
defineProps<{
  /** The route parameter the filter writes, which names the test id. */
  filterKey: string
  icon: string
  label: string
  /** What is picked, or the wording for no filter at all. */
  value: string
  /** Whether something is picked, which the chip carries as its own state. */
  picked: boolean
}>()
</script>

<template>
  <button
    type="button"
    :data-testid="`search-${filterKey}-chip`"
    :aria-label="`${label}: ${value}`"
    class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition hover:bg-elevated"
    :class="picked ? 'border-primary bg-elevated text-highlighted' : 'border-default bg-default text-toned'"
  >
    <UIcon :name="icon" class="size-3" />
    <span class="font-medium">{{ label }}</span>
    <span class="text-muted">{{ value }}</span>
    <UIcon name="i-lucide-chevron-down" class="size-3 text-dimmed" />
  </button>
</template>
