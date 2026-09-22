<script setup lang="ts">
/**
 * The chat below `lg`, where there is no side pane to hold it: a slideover
 * around the same `ChatPanel` the pane renders.
 */
const { chatOpen, closeChat, wide } = useSidePane()

const open = computed({
  get: () => chatOpen.value && !wide.value,
  set: (value) => { if (!value) closeChat() },
})
</script>

<template>
  <USlideover
    v-model:open="open"
    side="right"
    title="Ask OpenKnowledgebase"
    description="Answers grounded in your spaces"
    :ui="{ content: 'w-full sm:w-[520px] sm:max-w-[92vw]' }"
  >
    <template #content>
      <ChatPanel @close="closeChat()" />
    </template>
  </USlideover>
</template>
