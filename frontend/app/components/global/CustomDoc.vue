<script setup lang="ts">
/**
 * A link to another page. The tree passes (`shared/utils/comark-tree.ts`)
 * resolve the target under the reader's own auth, so the words in the slot are
 * the target's live title where the reader may see it and the author's stored
 * label where they may not. `nid`/`block` mirror the editor's own node, so a
 * copy of the rendered link keeps its target.
 */
defineProps<{
  href: string
  nid: number
  block?: string
  title?: string
}>()
</script>

<template>
  <NuxtLink :to="href" class="okb-doc-link" :data-nid="nid" :data-block="block" :title="title"><slot /></NuxtLink>
</template>
