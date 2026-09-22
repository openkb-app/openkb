<script setup lang="ts">
const { hide } = useSidePane()
</script>

<template>
  <UButton
    icon="i-lucide-panel-right-close"
    color="neutral"
    variant="ghost"
    size="sm"
    data-testid="side-pane-hide"
    aria-label="Hide the side pane"
    class="shrink-0"
    @click="hide({ focus: true })"
  />
</template>
