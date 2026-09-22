<script setup lang="ts">
/**
 * The OpenKnowledgebase mark and lockup (OKB-218, section 01).
 *
 * Drawn inline rather than loaded from `public/`, for two reasons: the fills
 * are the brand roles, so the reversed dark-scheme lockup is the same markup
 * under a different token block; and the wordmark is set in the page's own
 * Manrope rather than in whatever an `<img>` would find.
 *
 * `mark` is the compact form — the sidebar collapsed, or any context under the
 * lockup's 100px minimum width. The mark itself never goes below 16px.
 */
withDefaults(defineProps<{ variant?: 'lockup' | 'mark' }>(), { variant: 'lockup' })

// The mask is referenced by id, so two instances on one page must not share it.
const maskId = useId()
</script>

<template>
  <span
    class="inline-flex items-center gap-2.5"
    data-testid="okb-logo"
    :data-logo-variant="variant"
  >
    <!-- Clear space is the circle's radius, which the 48-unit box already
         leaves around the glyph; the block is masked where the circle
         overlaps it, so the two never merge into one shape. -->
    <svg
      class="h-7 w-7 shrink-0"
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <mask :id="maskId">
        <rect width="48" height="48" fill="white" />
        <circle cx="16" cy="24" r="15.5" fill="black" />
      </mask>
      <rect
        x="18" y="10" width="26" height="28" rx="8"
        data-logo-part="block"
        fill="var(--okb-agent)"
        :mask="`url(#${maskId})`"
      />
      <circle
        cx="16" cy="24" r="13"
        data-logo-part="circle"
        fill="var(--okb-primary)"
      />
    </svg>

    <span
      v-if="variant === 'lockup'"
      class="truncate text-base tracking-[-0.03em] text-(--okb-text)"
      data-logo-part="wordmark"
    ><span class="font-normal">Open</span><span class="font-semibold">Knowledgebase</span></span>
  </span>
</template>
