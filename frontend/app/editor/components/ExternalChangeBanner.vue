<script setup lang="ts">
defineEmits<{ reload: [] }>()
</script>

<template>
  <div
    data-testid="external-change-banner"
    class="mb-4 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 flex items-start gap-3"
  >
    <UIcon name="i-lucide-triangle-alert" class="mt-0.5 size-5 shrink-0 text-amber-700" />
    <div class="flex-1">
      <p class="font-medium text-amber-900 dark:text-amber-100">
        This page was changed elsewhere
      </p>
      <p class="text-sm text-amber-800 dark:text-amber-200 mt-1">
        Someone else (or an agent) committed a new version to history while you were editing. Reloading will fetch the latest revision; live edits not yet in history will be lost.
      </p>
    </div>
    <UButton color="warning" size="sm" @click="$emit('reload')">
      Reload
    </UButton>
  </div>
</template>
