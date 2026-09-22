<script setup lang="ts">
import type { BlockByline, ReviewStep } from '#shared/page-blocks'
import type { StepState } from '~/utils/block-byline'
import { blockCardView } from '~/utils/block-card'
import { CITE_STATE_GLYPH, CITE_STATE_NOTE, type CiteState } from '#shared/utils/citations'
import type { CitationSource } from '#shared/utils/comark-tree'

/**
 * The read page's per-block card.
 *
 * One panel for the whole page, not one per block: exactly one block is ever
 * being asked about, and a component per block would mean mounting Vue inside
 * the rendered page body — which the page cannot do (see BlockMargin.vue).
 * The trigger lives there as plain DOM and hands this component the button it
 * was pressed on; the panel is anchored to that button's box and rendered out
 * here, where it is an ordinary popover with the focus handling, Escape and
 * outside-dismissal that comes with one.
 *
 * ## Anchoring
 *
 * `UPopover` positions against an element in ITS own tree, so the anchor is a
 * zero-content div teleported to `<body>` and placed at the trigger's box in
 * DOCUMENT coordinates — not viewport ones. Document coordinates follow the
 * page as it scrolls without a scroll listener, which matters because the
 * trigger sits in the page column and the panel has to stay on it.
 *
 * The box is measured when the trigger changes and on resize: a reflow moves
 * the block the trigger sits under, and a panel left at the old box would
 * point at a different paragraph.
 */
const props = defineProps<{
  /** The block being asked about, or null when nothing is. */
  blockId: string | null
  /** That block's byline, as the read page was served it. */
  byline: BlockByline | null
  /** The sources that block cites, in the order it cites them. */
  sources?: CitationSource[] | null
  /** The trigger button, in the rendered page body. */
  trigger: HTMLElement | null
  /** The steps this space enforces, or null when untold — see `blockCardView`. */
  enforced?: readonly ReviewStep[] | null
  /** Where the page's revisions are, for a session allowed to see them. */
  historyHref?: string | null
  /** The reader's account, so their own agent is named as theirs. */
  viewerUid?: number | null
}>()

const open = defineModel<boolean>('open', { default: false })

const view = computed(() => (props.byline ? blockCardView(props.byline, props.enforced ?? null, props.viewerUid ?? null) : null))

const sources = computed(() => props.sources ?? [])

/** The trigger's box in document coordinates, or null before it is measured. */
const box = ref<{ top: number, left: number, width: number, height: number } | null>(null)

function measure(): void {
  const el = props.trigger
  if (!el || !el.isConnected) {
    box.value = null
    return
  }
  const rect = el.getBoundingClientRect()
  box.value = {
    top: rect.top + window.scrollY,
    left: rect.left + window.scrollX,
    width: rect.width,
    height: rect.height,
  }
}

const anchorStyle = computed(() => (box.value
  ? {
      position: 'absolute' as const,
      top: `${box.value.top}px`,
      left: `${box.value.left}px`,
      width: `${box.value.width}px`,
      height: `${box.value.height}px`,
      pointerEvents: 'none' as const,
    }
  : { display: 'none' }))

watch(() => props.trigger, () => measure(), { immediate: true })

onMounted(() => {
  window.addEventListener('resize', measure, { passive: true })
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', measure)
})

/**
 * Closing returns focus to the button that opened the panel.
 *
 * The popover cannot do it for us: its trigger is outside its own tree, so
 * there is nothing for it to restore focus to, and a dialog that dumps focus
 * on `<body>` loses a keyboard reader their place in the page.
 */
watch(open, (isOpen, was) => {
  if (was && !isOpen && props.trigger?.isConnected) props.trigger.focus()
})

/** The glyph each state carries, so it never rides colour alone (OKB-218). */
const STEP_GLYPH: Record<StepState, string> = {
  signed: '✔',
  awaiting: '◔',
}

const STEP_CLASS: Record<StepState, string> = {
  signed: 'text-(--okb-verified)',
  awaiting: 'text-(--okb-pending)',
}

/** The same two tones the chip in the prose carries. */
const SOURCE_CLASS: Record<Exclude<CiteState, 'ok'>, string> = {
  stale: 'bg-warning',
  dangling: 'bg-error',
}
</script>

<template>
  <Teleport to="body">
    <!-- `aria-label` on the content: the panel is a dialog with no title
         element of reka's own, and without a name it announces as an
         unlabelled dialog with the heading buried inside it. -->
    <UPopover
      v-model:open="open"
      :content="{ side: 'bottom', align: 'end', sideOffset: 6, 'aria-label': 'About this block' }"
      :ui="{ content: 'w-[22rem] max-w-[92vw] p-3' }"
    >
      <template #anchor>
        <div :style="anchorStyle" aria-hidden="true" />
      </template>

      <template #content>
        <div v-if="view || sources.length > 0" data-testid="block-card" :data-block-card-for="blockId" class="flex flex-col gap-2">
          <h2 class="text-[13px] font-semibold text-highlighted">
            About this block
          </h2>

          <!-- Everyone who touched it, named rather than ranked: the record is
               membership, so no contributor is the block's author (ADR 0002). -->
          <p
            v-if="view && view.contributors.length > 0"
            class="text-[12.5px] text-muted"
            data-testid="block-card-contributors"
          >
            Edited by <strong class="text-toned">{{ view?.contributors.join(', ') }}</strong>
          </p>

          <!-- Only steps with something to show: awaiting review, or signed
               off. With neither, render no list instead of an empty box. -->
          <ul v-if="view && view.steps.length > 0" class="flex flex-col gap-1.5 border-t border-default pt-2">
            <li
              v-for="row in view.steps"
              :key="row.step"
              class="flex items-start gap-2 text-[12.5px]"
              :data-review-step="row.step"
              :data-review-state="row.state"
            >
              <span
                class="mt-px inline-flex size-4 shrink-0 items-center justify-center rounded-full border text-[9px] font-bold"
                :class="STEP_CLASS[row.state]"
                aria-hidden="true"
              >{{ STEP_GLYPH[row.state] }}</span>
              <span class="min-w-0">
                <span class="font-medium text-toned">{{ row.title }}</span>
                <span class="text-muted"> — {{ row.detail }}</span>
              </span>
            </li>
          </ul>

          <!-- What this block was derived from, read off its own citations:
               the chips in the prose are the record, and this is the same list
               gathered in one place. -->
          <div v-if="sources.length > 0" class="flex flex-col gap-1.5 border-t border-default pt-2">
            <h3 class="text-[12px] font-semibold text-toned">
              Sources
            </h3>
            <ul class="flex flex-col gap-1" data-testid="block-card-sources">
              <li v-for="source in sources" :key="source.n" class="flex items-start gap-2 text-[12.5px]">
                <span
                  class="mt-px inline-flex size-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-inverted"
                  :class="source.state ? SOURCE_CLASS[source.state] : 'bg-primary'"
                  aria-hidden="true"
                >{{ source.n }}</span>
                <span class="min-w-0">
                  <NuxtLink
                    v-if="source.path"
                    :to="source.path"
                    class="font-medium text-toned underline underline-offset-2 hover:text-highlighted"
                    :data-cite-state="source.state"
                  >{{ source.title || `Source ${source.n}` }}</NuxtLink>
                  <!-- Nothing resolved for this reader, so there is nowhere to send them. -->
                  <span v-else class="font-medium text-toned" :data-cite-state="source.state">Source {{ source.n }}</span>
                  <span v-if="source.state" class="text-muted">
                    — {{ CITE_STATE_GLYPH[source.state] }} {{ CITE_STATE_NOTE[source.state] }}
                  </span>
                </span>
              </li>
            </ul>
          </div>

          <div v-if="historyHref" class="flex items-center border-t border-default pt-2 text-[12px]">
            <!-- The page's revisions, not the block's: nothing in this app
                 stores a block-level history, and a link that promised one
                 would open a page about the whole page. It goes to this app's
                 own history page in the same tab — an ordinary navigation
                 within the page's own site, which is what it now is. -->
            <NuxtLink
              :to="historyHref"
              class="ml-auto inline-flex items-center gap-1 text-muted underline underline-offset-2 hover:text-highlighted"
              data-testid="block-card-history"
            >
              <UIcon name="i-lucide-history" class="size-3" aria-hidden="true" />
              Page history
            </NuxtLink>
          </div>
        </div>
      </template>
    </UPopover>
  </Teleport>
</template>
