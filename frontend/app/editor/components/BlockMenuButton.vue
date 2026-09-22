<script setup lang="ts">
import type { EditorSession } from '~/components/PageInlineEditor.vue'

/**
 * The block menu, from the toolbar — the route to it that needs no pointer.
 *
 * The drag handle is the primary anchor and stays that: it names the block
 * under the cursor without a click. But it only appears on hover, and Nuxt
 * UI's theme hides it below `sm` outright, so on a phone it does not exist.
 * This opens the same menu on the block holding the caret, which a tap sets.
 */
const props = defineProps<{ session: EditorSession }>()

const items = props.session.blockMenu
</script>

<template>
  <UDropdownMenu
    :items="items"
    :content="{ align: 'start', side: 'bottom', onCloseAutoFocus: session.onBlockMenuCloseAutoFocus }"
    :ui="{ content: 'w-64', itemDescription: 'whitespace-normal' }"
    @update:open="open => open ? session.openBlockMenuAtCursor() : session.closeBlockMenu()"
  >
    <UButton
      color="neutral"
      variant="ghost"
      size="sm"
      icon="i-lucide-ellipsis-vertical"
      aria-label="Block actions"
      data-testid="block-menu-toolbar-trigger"
    />
  </UDropdownMenu>
</template>
