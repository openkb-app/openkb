<script setup lang="ts">
import type { LiveStatus } from '~/composables/useLiveCollab'

defineProps<{ status: LiveStatus }>()
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full"
    :class="{
      'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300': status === 'live',
      'bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300': status === 'connecting',
      'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300': status === 'offline',
      'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300': status === 'auth-error' || status === 'no-access',
    }"
  >
    <UIcon
      :name="
        status === 'auth-error' || status === 'no-access' ? 'i-lucide-lock'
        : status === 'offline' ? 'i-lucide-wifi-off'
        : status === 'connecting' ? 'i-lucide-loader-circle'
        : 'i-lucide-cloud-check'
      "
      class="size-3.5"
      :class="{ 'animate-spin': status === 'connecting' }"
    />
    {{
      status === 'auth-error' ? 'Not signed in'
      : status === 'no-access' ? 'No edit access'
      : status === 'offline' ? 'Offline — saves locally'
      : status === 'connecting' ? 'Connecting…'
      : 'Synced'
    }}
  </span>
</template>
