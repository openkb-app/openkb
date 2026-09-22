<script setup lang="ts">
import type { SidePaneContent } from '~/composables/useSidePane'

/**
 * The right pane: a column beside the page's body, so reading it and working in
 * the body happen at once. `wide` gates it — false until the app has mounted,
 * the one moment the server's render of this sibling and the browser's agree.
 */
const { content, visible, wide, closeChat } = useSidePane()
const { el, width, dragging, onPointerDown, onTouchStart, onKeydown, reset } = useSidePaneWidth()

/** What the region is called, in the words its own header shows. */
const LABEL: Record<SidePaneContent, string> = {
  outline: 'On this page',
  chat: 'Ask OpenKnowledgebase',
  comments: 'Review',
  summary: 'AI summary',
}
</script>

<template>
  <template v-if="wide && visible && content">
    <!-- The grab strip, on the pane's inner edge: four pixels, pulled back over
         the border so it is aimable without taking width from either column. -->
    <UDashboardResizeHandle
      data-testid="side-pane-resize"
      class="w-1 -ms-1 hover:bg-accented focus-visible:bg-primary focus-visible:outline-none data-[dragging=true]:bg-primary"
      tabindex="0"
      role="separator"
      aria-orientation="vertical"
      aria-controls="okb-side-pane"
      aria-label="Resize the side pane"
      :aria-valuenow="Math.round(width)"
      :aria-valuetext="`${Math.round(width)} percent`"
      :aria-valuemin="SIDE_PANE_MIN"
      :aria-valuemax="SIDE_PANE_MAX"
      :data-dragging="dragging"
      @mousedown="onPointerDown"
      @touchstart="onTouchStart"
      @keydown="onKeydown"
      @dblclick="reset"
    />

    <aside
      id="okb-side-pane"
      ref="el"
      :aria-label="LABEL[content]"
      class="relative flex min-h-0 w-(--width) shrink-0 flex-col border-s border-default"
      :style="{ '--width': `${width}%` }"
    >
      <!-- The chat brings its own band, so the pane's control goes inside it. -->
      <ChatPanel v-if="content === 'chat'" @close="closeChat()">
        <template #controls>
          <ChromeSidePaneHide />
        </template>
      </ChatPanel>

      <template v-else>
        <ChromeSidePaneBand>
          <h2 class="truncate text-sm font-semibold text-highlighted">
            {{ LABEL[content] }}
          </h2>
          <ChromeSidePaneHide class="ml-auto" />
        </ChromeSidePaneBand>

        <!-- `pb-28` clears the chat launcher. -->
        <div class="min-h-0 flex-1 overflow-y-auto p-4 pb-28">
          <!-- The outline's own title line would repeat the band above it, and
               its `lg:flex` needs the important modifier to yield. -->
          <ViewPageToc
            v-if="content === 'outline'"
            container-selector=".page-body"
            :ui="{ trigger: 'hidden!' }"
          />
          <!-- Whatever else the page asked for, rendered by the page itself. -->
          <slot v-else />
        </div>
      </template>
    </aside>
  </template>
</template>
