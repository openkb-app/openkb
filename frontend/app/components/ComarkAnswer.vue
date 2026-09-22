<script setup lang="ts">
/**
 * An assistant answer, rendered as the components the read view mounts: the
 * shared comark tree passes, then `@comark/vue`'s renderer.
 *
 * Parsing is async and re-runs on every streamed chunk, so the tree is
 * watch-driven and sequence-guarded — a slow parse of an earlier chunk must not
 * overwrite a newer one. comark auto-closes an open construct, so a fence that
 * is still streaming is already the mounted component.
 */
import { MarkdownDocument } from '@comark/vue'
import { comarkComponents } from '~/comark/components'
import { markdownToTree, type CitationChip, type ComarkNode } from '#shared/utils/comark-tree'
import type { ResolvedMedia } from '#shared/utils/media'

const props = defineProps<{
  /** Accumulated markdown. Grows chunk by chunk while the answer streams. */
  text: string
  /** The sources a bare `[n]` may be rendered as a clickable chip for. */
  citationChips?: readonly CitationChip[]
}>()

const nodes = shallowRef<ComarkNode[]>([])
const allowedHtml = useAllowedHtml()
let latest = 0

/**
 * Media this answer has asked for, held as the in-flight request so the deltas
 * arriving during one round-trip share it. Every delta re-parses the whole text.
 * A resolved `null` is a UUID the route had nothing for.
 */
const seen = new Map<string, Promise<ResolvedMedia | null>>()

/** Same route the editor's ImageNodeView resolves through. */
async function resolveMedia(uuids: string[]): Promise<Record<string, ResolvedMedia>> {
  const missing = uuids.filter(uuid => !seen.has(uuid))
  if (missing.length > 0) {
    const request = $fetch<{ items: Record<string, ResolvedMedia> }>(
      '/api/media/resolve',
      { query: { uuids: missing.join(',') } },
    ).then(({ items }) => items).catch(() => null)
    for (const uuid of missing) {
      seen.set(uuid, request.then(items => items?.[uuid] ?? null))
    }
    // A failed request is forgotten so the next delta can retry it.
    if (await request === null) for (const uuid of missing) seen.delete(uuid)
  }
  const items: Record<string, ResolvedMedia> = {}
  await Promise.all(uuids.map(async (uuid) => {
    const item = await seen.get(uuid)
    if (item) items[uuid] = item
  }))
  return items
}

/** `MarkdownDocument` re-renders on `value` identity, so the document object
 * must stay stable across renders that did not change the tree. */
const answer = computed(() => ({ nodes: nodes.value }))

// Keyed on what a chip shows rather than on the array: the citations arrive
// with the finished answer, and every delta re-renders the list around them.
watch([
  () => props.text,
  () => props.citationChips?.map(c => `${c.n}:${c.title}:${c.path}`).join(),
  allowedHtml,
], async ([text]) => {
  const seq = ++latest
  const next = await markdownToTree(text, {
    resolveMedia,
    citationChips: props.citationChips,
    allowedHtml: allowedHtml.value,
  })
  if (seq === latest) nodes.value = next
}, { immediate: true })
</script>

<template>
  <!-- The box scale goes on the renderer, not around it: `MarkdownDocument`
       roots the body in a `.comark-content` of its own, and the flush edges
       address the blocks' direct parent. The surface around it carries
       `okb-prose` (ChatPanel, search.vue), so this is nested in a column root
       like a callout body is. -->
  <MarkdownDocument
    class="okb-box-body okb-prose-compact"
    :value="answer"
    :components="comarkComponents"
    streaming
  />
</template>
