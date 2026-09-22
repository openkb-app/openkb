<script setup lang="ts">
// Owner + tags strip, rendered between the lede and the page body.
//
// Both values come from real fields exposed on the CE display, reduced to
// labels by the caller: `owner` is field_owner (the user accountable for
// keeping the page current) and `tags` is field_tags. Either may be empty — the
// strip then renders only what the node actually carries, and disappears
// entirely when it carries neither.
//
// Per-contributor attribution is not shown here: contributions are tracked per
// block by the provenance layer (OKB-82), which is where a reader can see who
// wrote what.
import { ownerInitials } from '#shared/utils/kb-meta'

const props = defineProps<{
  owner?: string
  tags?: string[]
  /**
   * Whether the values shown here are editable — set in edit mode, where the
   * Details form owns them and this strip is the way into it.
   */
  editable?: boolean
}>()

const emit = defineEmits<{
  /** Edit one frontmatter field, by its key. Only fired while `editable`. */
  editField: [key: string]
}>()

const tags = computed(() => props.tags ?? [])
const hasMeta = computed(() => !!props.owner || tags.value.length > 0)

// Edit mode turns each half into one control into its own field. Read mode
// renders the same markup as a plain span, with no handler and no affordance.
const EDIT_CLASS = 'cursor-pointer rounded hover:bg-elevated focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary'
const as = computed(() => (props.editable ? 'button' : 'div'))
</script>

<template>
  <div
    v-if="hasMeta"
    class="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-t border-default py-3.5"
  >
    <component
      :is="as"
      v-if="owner"
      :type="editable ? 'button' : undefined"
      class="flex items-center gap-2 text-start"
      :class="editable ? EDIT_CLASS : undefined"
      :aria-label="editable ? `Edit the owner: ${owner}` : undefined"
      data-testid="page-owner"
      @click="editable && emit('editField', 'owner')"
    >
      <UAvatar :text="ownerInitials(owner)" color="primary" size="sm" />
      <span class="block leading-tight">
        <span class="block text-[13px] font-medium text-highlighted">
          {{ owner }}
        </span>
        <span class="block text-[11.5px] text-muted">
          Owner
        </span>
      </span>
    </component>

    <span v-if="owner && tags.length" class="hidden h-6 w-px bg-default sm:block" />

    <component
      :is="as"
      v-if="tags.length"
      :type="editable ? 'button' : undefined"
      class="flex flex-wrap items-center gap-1"
      :class="editable ? EDIT_CLASS : undefined"
      :aria-label="editable ? `Edit the tags: ${tags.join(', ')}` : undefined"
      data-testid="page-tags"
      @click="editable && emit('editField', 'tags')"
    >
      <UBadge
        v-for="tag in tags"
        :key="tag"
        color="neutral"
        variant="soft"
        size="xs"
      >
        {{ tag }}
      </UBadge>
    </component>
  </div>
</template>
