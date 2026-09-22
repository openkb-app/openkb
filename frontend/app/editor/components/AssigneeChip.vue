<script setup lang="ts">
// Explicit, not auto-imported: the component is rendered by its own vitest
// suite outside a Nuxt app.
import { computed } from 'vue'
import { ownedLabel } from '#shared/utils/attribution'
import EditorPeerAvatar from './PeerAvatar.vue'
import { collabColor } from '#shared/utils/presence'
import type { CommentAssignee } from '#shared/block-comments'

/**
 * Whose thread this is — avatar plus name, and the way to reassign it. Initials
 * name nobody, so the accessible name carries the full attribution and what
 * pressing it does.
 */
const props = defineProps<{
  assignee: CommentAssignee
  /** The reader's own account, so their own agent reads as theirs. */
  viewerUid?: number | null
}>()

const label = computed(() => ownedLabel(props.assignee, props.viewerUid ?? null))
const color = computed(() => (props.assignee.uid == null ? null : collabColor(props.assignee.uid)))
</script>

<template>
  <UButton
    color="neutral"
    variant="soft"
    size="xs"
    class="max-w-[12rem]"
    :aria-label="`Assigned to ${label} — change`"
    :title="`Assigned to ${label}`"
    data-testid="assignee-chip"
  >
    <EditorPeerAvatar size="3xs" :name="assignee.name" :color="color" :via="assignee.via" />
    <span class="truncate">{{ label }}</span>
  </UButton>
</template>
