<script setup lang="ts">
// FAB for the Ask OpenKnowledgebase chat. The chat renders in the page's side
// pane from `lg` and in the slideover below it; this button just toggles it.
//
// It floats over every page, so it takes pointer events only where it is
// actually clickable: the button. The container's dead space and the keyboard
// hint above it stay transparent to the pointer — otherwise they swallow
// clicks on whatever page control happens to sit in the bottom-right corner.
const { content, hidden, toggleChat } = useSidePane()

// The chat is already on screen, and the button's place is over its composer.
const shown = computed(() => content.value === 'chat' && !hidden.value)
</script>

<template>
  <div v-if="!shown" class="pointer-events-none fixed bottom-5 right-5 z-40 flex flex-col items-end gap-2">
    <!-- The hint is decoration; a phone gets the button alone. -->
    <div aria-hidden="true" class="hidden gap-0.5 sm:flex">
      <UKbd value="meta" /><UKbd value="j" />
    </div>
    <button
      type="button"
      aria-label="Ask OpenKnowledgebase"
      title="Ask OpenKnowledgebase"
      data-test="chat-fab"
      class="pointer-events-auto flex h-12 w-12 items-center justify-center rounded-full bg-(--okb-agent-text) text-inverted shadow-xl transition hover:-translate-y-0.5 hover:shadow-2xl"
      @click="toggleChat()"
    >
      <UIcon name="i-lucide-sparkles" class="size-5" />
    </button>
  </div>
</template>
