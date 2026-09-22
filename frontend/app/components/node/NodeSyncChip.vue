<script setup lang="ts">
import type { EditorSession } from '~/components/PageInlineEditor.vue'
import { syncChipView } from '~/utils/node-chrome'

const props = defineProps<{ session: EditorSession }>()

const chip = computed(() => syncChipView(
  props.session.liveStatus.value,
  props.session.savedAgo.value,
  props.session.commitStatus.value,
  props.session.commitError.value,
))
</script>

<template>
  <!-- The one state indicator in edit mode: live-session health, or the commit
       lane (Saving… / Unsaved changes / Synced) once the socket is up. The
       label is the first thing the responsive collapse gives back — below the
       `editnav` container breakpoint the icon carries it, with the label as its
       title — because the editing toolbars beside it need the width more. -->
  <UBadge
    :color="chip.color"
    variant="subtle"
    size="md"
    :title="chip.label"
    data-testid="editor-sync-chip"
    :data-live-status="session.liveStatus.value"
  >
    <UIcon
      :name="chip.icon"
      class="size-3"
      :class="chip.spin ? 'animate-spin' : ''"
      aria-hidden="true"
    />
    <!-- The label is the badge's accessible name, so it is always in the tree —
         `sr-only` when the container is too narrow to show it, visible again at
         the breakpoint. A bare `aria-label` on the badge span is ARIA-prohibited
         (a span has no name-bearing role). -->
    <span class="sr-only @3xl/editnav:not-sr-only">{{ chip.label }}</span>
  </UBadge>
</template>
