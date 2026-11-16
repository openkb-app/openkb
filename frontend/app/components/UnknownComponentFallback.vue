<script setup lang="ts">
/**
 * The renderer for a comark component nobody has built.
 *
 * The tree passes rewrite every unknown component tag to this one and keep the
 * authored name, so the words inside an unknown fence stay readable and no
 * fence can name an app component into the page. An assistant can name a
 * component that does not exist. `inline` is an unknown component sitting in a
 * paragraph, where a `<div>` may not go.
 */
defineProps<{ name?: string, inline?: boolean }>()
</script>

<template>
  <component :is="inline ? 'span' : 'div'" class="contents" :data-comark-component="name">
    <slot />
  </component>
</template>
