<script setup lang="ts">
/**
 * Every tab reads "<Page> · OpenKnowledgebase", so a page is identifiable in a
 * tab list and in a screen reader's window switcher; a page that names nothing
 * of its own falls back to the product name alone.
 */
useHead({
  titleTemplate: title => (title ? `${title} · OpenKnowledgebase` : 'OpenKnowledgebase'),
})
</script>

<template>
  <UApp>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
