<script setup lang="ts">
import type { ChatThreadSession } from '~/composables/useChatCommentHandler'

/**
 * Runs the chat comment handler for the page. A component of its own, so the
 * chat runtime loads lazily with it, once an edit session exists.
 */
const props = defineProps<{
  session: ChatThreadSession | null
  uid: number | null
}>()

useChatCommentHandler(toRef(props, 'session'), toRef(props, 'uid'))
</script>

<template>
  <!-- Renders nothing. -->
</template>
