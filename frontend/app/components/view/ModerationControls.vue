<script setup lang="ts">
import {
  canPublishNow,
  canRevertNow,
  describesADraft,
  moderationBadges,
  publishRefusal,
  type ModerationStatus,
} from '#shared/utils/moderation'

/**
 * The document-level moderation chrome (OKB-84): where the page stands, and
 * the two actions that move it.
 *
 * Lives in the read page's existing navbar action slot in both read and
 * edit mode — same 52px header, nothing pushed down, per the variant-D
 * no-layout-jump rule. It renders exactly what the status permits: an
 * unmoderated page (or a status that could not be read) produces no
 * element at all rather than disabled buttons, so when moderation becomes a
 * per-space setting (OKB-86) turning it off removes the chrome instead of
 * greying it out.
 *
 * Reverting is destructive to the draft, so it confirms. The dialog is a plain
 * one on purpose: the draft-vs-published diff that will preview what is being
 * discarded is OKB-91, and this is its placeholder — the copy states what is
 * lost and what is kept rather than pretending to show it.
 */
const props = defineProps<{
  status: ModerationStatus | null
  busy: 'publish' | 'revert' | null
  /** Compact mode drops the badge labels below lg — edit mode's toolbar wins
   *  the header space, and the state is still carried by the icon + tooltip.
   *  Below `sm` the badges go either way: at 375px the header has room for the
   *  sidebar toggle, the trail, the transition buttons and identity, and the
   *  status is what the buttons on offer already say. */
  compact?: boolean
  /** The live session has edits Drupal has not seen. Publish offers itself for
   *  those too — the endpoint checkpoints before it transitions. */
  pendingEdits?: boolean
  /** How many blocks the review gate is still holding (OKB-121). */
  awaiting?: number
  /** Edit mode keeps only Publish: the state is carried by the sync chip and
   *  the badges/Revert-to-published belong to the read page, so the header has
   *  room for the editing toolbars. */
  publishOnly?: boolean
  /** Whether this session may edit — what makes the draft badge a link. */
  canEdit?: boolean
}>()

const emit = defineEmits<{ publish: [], revert: [] }>()

const badges = computed(() => moderationBadges(props.status, props.canEdit))

// The edit surface is a query on the page's own route, so the badge links to
// where the reader already is. Kept whole rather than replaced, or following it
// would drop whatever else the URL carries.
const route = useRoute()
const editTo = computed(() => ({ query: { ...route.query, edit: '' } }))
// The badge renders AS the link rather than inside one, so the whole chip is
// the target and the layout does not gain a wrapper.
const NuxtLink = resolveComponent('NuxtLink')
const awaiting = computed(() => props.awaiting ?? 0)
// Publishing belongs to the edit page (fago, 14.09.): the read page shows
// where the page stands and offers the way back to it.
const showPublish = computed(() => !!props.publishOnly && canPublishNow(props.status, props.pendingEdits))
// A publish the review holds is greyed with its reason rather than hidden: the
// reviewer needs to know which blocks are waiting. `aria-disabled` over Nuxt
// UI's `disabled`, which drops the tooltip carrying that reason.
const refusal = computed(() => publishRefusal(props.status, awaiting.value))
const showRevert = computed(() => canRevertNow(props.status))

const confirmOpen = ref(false)

function confirmRevert() {
  confirmOpen.value = false
  emit('revert')
}
</script>

<template>
  <!-- Chrome needs a draft to describe, except in edit mode, which offers
       Publish before the first draft exists. -->
  <template v-if="describesADraft(status) || publishOnly">
    <template v-if="!publishOnly">
      <UBadge
        v-for="badge in badges"
        :key="badge.label"
        :color="badge.color"
        variant="subtle"
        size="md"
        :as="badge.linkToEdit ? NuxtLink : 'span'"
        :to="badge.linkToEdit ? editTo : undefined"
        :data-testid="`moderation-badge-${badge.label.toLowerCase().replace(/[^a-z]+/g, '-')}`"
        :title="badge.linkToEdit ? `${badge.label} — open the editor` : badge.label"
        :class="compact ? 'hidden lg:inline-flex' : 'hidden sm:inline-flex'"
      >
        <UIcon :name="badge.icon" class="size-3" aria-hidden="true" />
        {{ badge.label }}
      </UBadge>
    </template>

    <!-- Below `sm` both transitions keep their icon and drop their label, so
         they stay reachable without pushing the trail out of the header. The
         `aria-label` is the full label either way. -->
    <UButton
      v-if="showRevert && !publishOnly"
      color="neutral"
      variant="soft"
      size="sm"
      icon="i-lucide-history"
      aria-label="Revert to published"
      data-testid="moderation-revert"
      :loading="busy === 'revert'"
      :disabled="!!busy"
      @click="confirmOpen = true"
    >
      <span class="hidden sm:inline">Revert to published</span>
    </UButton>

    <UTooltip
      v-if="showPublish"
      :text="refusal ?? 'Publish'"
      :content="{ side: 'bottom' }"
    >
      <UButton
        color="primary"
        variant="solid"
        size="sm"
        icon="i-lucide-globe"
        aria-label="Publish"
        data-testid="moderation-publish"
        :loading="busy === 'publish'"
        :disabled="!!busy"
        :aria-disabled="refusal ? 'true' : undefined"
        :class="refusal ? 'opacity-50' : undefined"
        @click="refusal || emit('publish')"
      >
        <span class="hidden sm:inline">Publish</span>
      </UButton>
    </UTooltip>

    <UModal
      v-model:open="confirmOpen"
      title="Revert to published?"
      description="The unpublished draft is discarded and this page goes back to what the live page shows. Nothing is deleted — the discarded revision stays in the page's history."
    >
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            data-testid="moderation-revert-cancel"
            @click="confirmOpen = false"
          >
            Cancel
          </UButton>
          <UButton
            color="error"
            icon="i-lucide-history"
            data-testid="moderation-revert-confirm"
            @click="confirmRevert"
          >
            Discard draft
          </UButton>
        </div>
      </template>
    </UModal>
  </template>
</template>
