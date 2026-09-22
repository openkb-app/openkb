<script setup lang="ts">
/**
 * Renders an HTML fragment supplied by the Drupal CE-API.
 *
 * In the explicit JSON format the Nuxt module hands the HTML to us via the
 * default slot (the `default` slot of a custom element ships as a string when
 * it isn't a child CE node). The optional `content` prop is kept for callers
 * that pass HTML imperatively (e.g. when the entire slot is a bare string —
 * `renderCustomElements` wraps that case into <drupal-markup :content="…" />).
 *
 * `v-drupal-markup` (the module's directive) ships the HTML as an SSR-only
 * prop, so hydration adopts the server-rendered nodes instead of re-creating
 * them — what a visitor typed into a Drupal-rendered form before the app took
 * over survives.
 */
defineProps<{ content?: string }>()

defineSlots<{ default?: () => unknown }>()
</script>

<template>
  <slot />
  <div
    v-if="content"
    v-drupal-markup="content"
    style="display: contents"
  />
</template>
