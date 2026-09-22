<script setup lang="ts">
import type { SidePaneContent } from '~/composables/useSidePane'

/**
 * Everything a page shows under its header: the body column and the side pane,
 * each with its own scroller, so reading one never moves the other.
 *
 * `pane` is what this page wants shown there; an open chat takes it from them.
 */
const props = defineProps<{ pane?: SidePaneContent }>()

const { request } = useSidePane()
watchEffect(() => request(props.pane ?? null))
</script>

<template>
  <div class="flex min-h-0 flex-1">
    <!-- The panel holds no body padding, so this column carries it. `pb-28`
         clears the chat launcher. -->
    <div
      data-testid="page-column"
      class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 pb-28 sm:gap-6 sm:p-6"
    >
      <slot />
    </div>
    <ChromeSidePane>
      <slot name="pane" />
    </ChromeSidePane>
  </div>
</template>
