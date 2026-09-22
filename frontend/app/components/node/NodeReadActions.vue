<script setup lang="ts">
import type { ModerationStatus } from '#shared/utils/moderation'

defineProps<{
  status: ModerationStatus | null
  busy: 'publish' | 'revert' | null
  nid?: number
  canEdit: boolean
  canDelete: boolean
  /** 'preparing' while the editor preloads — the Edit button shows the spinner. */
  mode: 'read' | 'preparing' | 'edit'
  title: string
  /** The page's revisions page, when this session may follow it. */
  historyHref?: string | null
  /** The page's raw-markdown endpoint (View as Markdown). */
  markdownHref?: string
}>()

const emit = defineEmits<{
  (e: 'revert'): void
  (e: 'edit'): void
  (e: 'deleted'): void
}>()

const { toggleChat } = useSidePane()

// Edit is a client-side handler, so a click before the app has hydrated reaches
// nothing at all and is lost. Offer the control only once it can act. Only the
// hydrating first load is gated; a client-side navigation arrives ready.
const nuxtApp = useNuxtApp()
const ready = ref(import.meta.client && !nuxtApp.isHydrating)
onNuxtReady(() => { ready.value = true })
</script>

<template>
  <ViewModerationControls
    :status="status"
    :busy="busy"
    :can-edit="canEdit"
    @revert="emit('revert')"
  />
  <UButton
    v-if="nid && canEdit"
    color="primary"
    variant="solid"
    size="sm"
    icon="i-lucide-pencil"
    aria-label="Edit"
    :disabled="!ready"
    :loading="mode === 'preparing'"
    @click="emit('edit')"
  >
    <!-- Icon-only below `sm`: every character the actions give back is a
         character the breadcrumb trail keeps, and the trail is the only
         orientation on a phone. -->
    <span class="hidden sm:inline">Edit</span>
  </UButton>
  <!-- No Edit means this session may read but not write here (a plain member of
       the space, say). Say so, rather than leaving the space where the Edit
       button would be silent — an absent button reads as "nothing to do", a
       Read-only chip reads as "this is why". -->
  <UBadge
    v-else-if="nid"
    color="neutral"
    variant="soft"
    size="md"
    icon="i-lucide-eye"
    data-testid="read-only-indicator"
  >
    Read only
  </UBadge>
  <!-- Ask AI sits right of Edit. Yields below md so the breadcrumb trail keeps
       its width: Edit is the only action worth the header on a phone, and the
       floating launcher still opens the same chat at every viewport. -->
  <UButton
    color="neutral"
    variant="outline"
    size="sm"
    icon="i-lucide-sparkles"
    class="hidden md:inline-flex"
    @click="toggleChat()"
  >
    Ask AI
  </UButton>
  <!-- One page-actions menu, the same one edit mode shows. It is offered to
       every reader: Versions and View as Markdown are about the page, not
       about editing it. Move carries the same access signal as Edit, since both
       are node-update acts; delete carries Drupal's own delete grant, which is
       a different permission. -->
  <ViewPageMenu
    v-if="nid"
    :nid="nid"
    :title="title"
    :can-move="canEdit"
    :can-delete="canDelete"
    :history-href="historyHref"
    :markdown-href="markdownHref"
    @deleted="emit('deleted')"
  />
</template>
