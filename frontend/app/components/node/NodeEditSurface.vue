<script setup lang="ts">
import type { EditorSession } from '~/components/PageInlineEditor.vue'
import type { ReviewStep } from '#shared/page-blocks'

/**
 * The collab editor, mounted hidden in the content column so read→edit is one
 * atomic swap and not a navigation. It shares the page body's prose metrics
 * (the parent wraps it in the same `.prose` column), so entering edit moves no
 * paragraph. Any editable node type mounts it the same way.
 */
defineProps<{
  mode: 'read' | 'preparing' | 'edit'
  nid: number
  steps: readonly ReviewStep[]
  /** Whether this session may moderate past the four-eyes rule (ADR 0002). */
  mayModerate: boolean
}>()

const emit = defineEmits<{ (e: 'session', session: EditorSession): void }>()
</script>

<template>
  <div
    v-if="mode !== 'read'"
    :class="mode === 'preparing' ? 'invisible absolute inset-x-0 top-0' : ''"
  >
    <Suspense>
      <PageInlineEditor
        :nid="nid"
        :steps="steps"
        :may-moderate="mayModerate"
        @session="emit('session', $event)"
      />
    </Suspense>
  </div>
</template>
