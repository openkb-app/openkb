<script setup lang="ts">
import type { SidePaneContent } from '~/composables/useSidePane'

/**
 * The right pane: a column beside the page's body, so reading it and working in
 * the body happen at once. `wide` gates it — false until the app has mounted,
 * the one moment the server's render of this sibling and the browser's agree.
 */
const { content, visible, wide, chatOpen, chatEnlarged, reviewCollapsed, openChat, closeChat } = useSidePane()
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

    <!-- An enlarged chat is laid over the page's whole row, so the pane is not
         what it is positioned against then. -->
    <aside
      id="okb-side-pane"
      ref="el"
      :aria-label="LABEL[content]"
      class="flex min-h-0 w-(--width) shrink-0 flex-col border-s border-default"
      :class="{ relative: !chatEnlarged }"
      :style="{ '--width': `${width}%` }"
    >
      <!-- The chat brings its own band, so the pane's control goes inside it. -->
      <ChatPanel v-if="content === 'chat'" @close="closeChat()">
        <template #controls>
          <ChromeSidePaneHide />
        </template>
      </ChatPanel>

      <!-- Editing: Review on top, the chat below, each folding to its band. -->
      <template v-else-if="content === 'comments'">
        <section
          data-testid="pane-review"
          aria-labelledby="okb-pane-review-title"
          class="flex min-h-0 flex-col"
          :class="reviewCollapsed ? 'shrink-0' : 'flex-1'"
        >
          <ChromeSidePaneBand>
            <h2 id="okb-pane-review-title" class="min-w-0 text-sm font-semibold text-highlighted">
              <UButton
                :icon="reviewCollapsed ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'"
                color="neutral"
                variant="ghost"
                size="sm"
                data-testid="pane-review-toggle"
                :aria-expanded="!reviewCollapsed"
                aria-controls="okb-pane-review-body"
                class="max-w-full"
                @click="reviewCollapsed = !reviewCollapsed"
              >
                <span class="truncate">{{ LABEL.comments }}</span>
              </UButton>
            </h2>
            <ChromeSidePaneHide class="ml-auto" />
          </ChromeSidePaneBand>
          <!-- `pb-28` clears the chat launcher when no chat is below. -->
          <div
            v-show="!reviewCollapsed"
            id="okb-pane-review-body"
            class="min-h-0 flex-1 overflow-y-auto p-4"
            :class="{ 'pb-28': !chatOpen }"
          >
            <slot />
          </div>
        </section>

        <section
          data-testid="pane-chat"
          :aria-label="LABEL.chat"
          class="flex min-h-0 flex-col border-t border-default"
          :class="chatOpen ? 'flex-1' : 'shrink-0'"
        >
          <ChatPanel v-if="chatOpen" @close="closeChat()">
            <template #controls>
              <UButton
                icon="i-lucide-chevron-down"
                color="neutral"
                variant="ghost"
                size="sm"
                data-testid="pane-chat-collapse"
                aria-expanded="true"
                aria-label="Collapse the chat"
                class="shrink-0"
                @click="closeChat()"
              />
            </template>
          </ChatPanel>
          <ChromeSidePaneBand v-else>
            <h2 class="min-w-0 text-sm font-semibold text-highlighted">
              <UButton
                icon="i-lucide-chevron-right"
                color="neutral"
                variant="ghost"
                size="sm"
                data-testid="pane-chat-expand"
                aria-expanded="false"
                class="max-w-full"
                @click="openChat()"
              >
                <span class="truncate">AI assistant</span>
              </UButton>
            </h2>
          </ChromeSidePaneBand>
        </section>
      </template>

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
