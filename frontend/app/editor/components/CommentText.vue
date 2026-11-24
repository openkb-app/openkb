<script setup lang="ts">
// Explicit, not auto-imported: rendered by CommentThreads' vitest suite outside a Nuxt app.
import { computed, shallowRef, watch } from 'vue'
import { MarkdownDocument } from '@comark/vue'
import { markdownToTree, type AllowedHtml, type ComarkNode } from '#shared/utils/comark-tree'
import Mention from '../../components/comark/inline/Mention.vue'

/**
 * One comment's words: comark text, parsed by the page body's parser, with
 * mentions drawn by the page body's chip. Paragraphs, line breaks and mentions
 * are kept; any other markup reads as its text.
 */
const props = defineProps<{
  /** The stored comment text. */
  text: string
}>()

/** What a comment renders: paragraphs, line breaks and mentions. */
const COMMENT_HTML: AllowedHtml = { p: {}, br: {}, mention: {} }

const nodes = shallowRef<ComarkNode[]>([])
let latest = 0

watch(() => props.text, async (text) => {
  const seq = ++latest
  const next = await markdownToTree(text, { allowedHtml: COMMENT_HTML })
  if (seq === latest) nodes.value = next
}, { immediate: true })

/** `MarkdownDocument` re-renders on `value` identity. */
const document = computed(() => ({ nodes: nodes.value }))
</script>

<template>
  <div>
    <!-- The renderer's setup is async; the boundary keeps a comment from waiting on the page's. -->
    <Suspense>
      <MarkdownDocument :value="document" :components="{ p: 'p', br: 'br', mention: Mention }" />
    </Suspense>
  </div>
</template>
