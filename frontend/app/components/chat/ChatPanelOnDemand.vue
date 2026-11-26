<script setup lang="ts">
/**
 * The chat panel, loaded on first use. A failed load says so, with a reload to
 * fetch the chat again and a way to close it.
 */
const emit = defineEmits<{ close: [] }>()

const failedActions = [
  { label: 'Reload', onClick: () => reloadNuxtApp({ force: true }) },
  { label: 'Close', color: 'neutral' as const, variant: 'outline' as const, onClick: () => emit('close') },
]
</script>

<template>
  <NuxtErrorBoundary>
    <LazyChatPanel @close="emit('close')">
      <template v-if="$slots.controls" #controls>
        <slot name="controls" />
      </template>
    </LazyChatPanel>
    <template #error>
      <div class="p-4">
        <UAlert
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="The chat could not load"
          description="Check the connection, then reload the page."
          :actions="failedActions"
        />
      </div>
    </template>
  </NuxtErrorBoundary>
</template>
