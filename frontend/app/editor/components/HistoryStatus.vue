<script setup lang="ts">
import type { CommitStatus } from '~/composables/useDrupalCommitState'

defineProps<{
  status: CommitStatus
  error?: string | null
  savedAgo?: string | null
}>()
</script>

<template>
  <span class="text-xs text-gray-500 dark:text-gray-400">
    <template v-if="status === 'saving'">Saving to history…</template>
    <template v-else-if="status === 'saved' && savedAgo">In history {{ savedAgo }}</template>
    <template v-else-if="status === 'error'">{{ error || 'Save failed' }}</template>
    <template v-else-if="status === 'dirty'">Unsaved changes</template>
    <template v-else>—</template>
  </span>
</template>
