<script setup lang="ts">
import type { Editor } from '@tiptap/core'
import { TITLE_KEY } from '~~/server/utils/entity-fields'
import { reviewPills, type ReviewMark } from '~/editor/review-marks'
import type { FrontmatterFormApi } from '~/composables/useFrontmatterForm'
import type { ReviewStep } from '#shared/page-blocks'

/**
 * The page title, editable in place at the top of the document.
 *
 * It is a textarea above the ProseMirror root, not a node in it: the title is
 * a node field, so the editor holds no block for it, it wears no block chrome
 * and there is nothing in the document to delete or duplicate. The `# <title>`
 * line a write stores carries a block id all the same — the lead section's
 * anchor, which no block operation can name.
 * It writes the same `fields` Y.Map binding the Details panel writes, so the
 * two stay in step and peers see the rename live.
 *
 * A hidden copy of the text sets the height, in the same grid cell — so the
 * box is the read view's H1 to the pixel, and grows with a wrapped title
 * without measuring anything.
 *
 * A rename is a review item like a block's text, so the heading carries the
 * same pills and the same sign-off control (ADR 0017).
 */
const props = defineProps<{
  frontmatter: FrontmatterFormApi
  /** Shown until the session's field map is seeded. */
  fallback: string
  /** The document below, for the caret to carry on into. */
  editor: Editor | null
  /** What the sidecar says about the title, or null when it owes nothing. */
  review?: ReviewMark | null
}>()

const emit = defineEmits<{ approve: [ReviewStep] }>()

/** The same pills a pending block draws, about the title instead. */
const pills = computed(() => (props.review ? reviewPills(props.review) : []))

/** Shape beside colour, the same glyphs the margin pills carry. */
const GLYPH: Record<string, string> = {
  'reviewable': '\u25CF',
  'awaiting-others': '\u25CB',
  'unattributed': '?',
  'reviewed': '\u2713',
  'agent': '\u25C6',
}

const input = ref<HTMLTextAreaElement | null>(null)

/**
 * A title is one line: a pasted newline would spill the rest of it into the
 * body, under the heading's block id. Only a paste can bring one, so typing
 * keeps the spaces it puts in.
 */
function oneLine(value: string): string {
  return value.includes('\n') ? value.replace(/\s*\n\s*/g, ' ').trim() : value
}

const title = computed({
  get: () => props.frontmatter.seeded.value
    ? String(props.frontmatter.field(TITLE_KEY).value ?? '')
    : props.fallback,
  set: (value) => {
    // Before the seed the value on screen is the page's own title, not the
    // session's — writing then would be typing over a field nobody has read.
    if (!props.frontmatter.seeded.value) return
    const next = oneLine(value)
    props.frontmatter.field(TITLE_KEY).value = next
    // Vue repaints what changed: a paste normalised back to the title already
    // held would leave its line break on screen.
    if (next !== value && input.value) input.value.value = next
  },
})

/** What the commit path's 422 mapping said about the title, if anything. */
const errors = computed(() => props.frontmatter.errors.value[TITLE_KEY] ?? [])

/** Enter belongs to the body: a title is one line, and the caret carries on. */
function toBody(): void {
  props.editor?.commands.focus('start')
}
</script>

<template>
  <!-- Still the page's heading, and named by the value the textbox holds: a
       heading takes an embedded control's value as its accessible name. -->
  <h1 class="mb-3 grid text-[26px] font-bold leading-[1.15] tracking-tight text-highlighted sm:text-[34px]">
    <span aria-hidden="true" class="invisible col-start-1 row-start-1 whitespace-pre-wrap break-words">{{ title }}&#8203;</span>
    <textarea
      ref="input"
      v-model="title"
      rows="1"
      aria-label="Page title"
      data-testid="editor-title"
      :readonly="!frontmatter.seeded.value"
      :aria-invalid="errors.length > 0"
      :aria-describedby="errors.length ? 'editor-title-error' : undefined"
      class="col-start-1 row-start-1 resize-none overflow-hidden rounded-sm border-0 bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-(--ui-primary)"
      :class="errors.length ? 'text-error' : ''"
      @focusin="frontmatter.focusField(TITLE_KEY)"
      @focusout="frontmatter.focusField(null)"
      @keydown.enter.prevent="toBody"
    />
    <span v-if="errors.length" id="editor-title-error" class="mt-1 block text-[11px] font-medium text-error">
      {{ errors.join(' ') }}
    </span>
    <!-- Under the heading rather than in its grid cell: the two cells hold the
         textbox and its height-setting copy, and a third would overlap them.
         Always shown, unlike a block's — the heading has no margin line to
         open on hover, and the pill is the only thing that says the rename is
         being held. -->
    <span
      v-if="pills.length > 0"
      class="okb-title-review"
      data-testid="editor-title-review"
    >
      <span v-for="pill in pills" :key="pill.label" class="okb-title-review-pair">
        <!-- The words are real text here, unlike the margin pill a block
             draws: that one sits inside its block, where text would join the
             block's own. The glyph says in shape what the colour says. -->
        <span
          :id="`okb-title-pill-${pill.tone}`"
          :class="`okb-review-pill okb-review-pill--${pill.tone}`"
        >
          <span aria-hidden="true">{{ GLYPH[pill.tone] }}</span>
          {{ pill.label }}
        </span>
        <span
          v-if="pill.approve?.refusal"
          :id="`okb-title-why-${pill.tone}`"
          class="sr-only"
        >{{ pill.approve.refusal }}</span>
        <button
          v-if="pill.approve"
          type="button"
          :class="`okb-review-approve okb-review-approve--${pill.tone}`"
          :aria-label="pill.approve.label"
          :aria-describedby="pill.approve.refusal
            ? `okb-title-pill-${pill.tone} okb-title-why-${pill.tone}`
            : `okb-title-pill-${pill.tone}`"
          :aria-disabled="pill.approve.refusal ? 'true' : undefined"
          :title="pill.approve.refusal ?? undefined"
          :data-testid="`editor-title-approve-${pill.approve.step}`"
          @click="pill.approve.refusal || emit('approve', pill.approve.step)"
        />
      </span>
    </span>
  </h1>
</template>

<style scoped>
/* The textbox is the heading: same face, same spacing, no chrome of its own. */
textarea {
  font: inherit;
  letter-spacing: inherit;
  color: inherit;
}
</style>
