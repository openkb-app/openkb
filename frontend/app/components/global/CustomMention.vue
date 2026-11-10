<script setup lang="ts">
/**
 * A mention of a user, `:mention[label]{uid="N"}`: the same chip markup as
 * the editor's mention node (`app/editor/nodes/mention.ts`), `data-label`
 * included, so a chip pasted into the editor keeps its label. The tree pass
 * sets `label` from the mention's words.
 */
defineProps<{ uid?: string, label?: string, inline?: boolean }>()
</script>

<template>
  <span class="mention" data-type="mention" :data-id="uid" :data-label="label || undefined">@<slot /></span>
</template>
