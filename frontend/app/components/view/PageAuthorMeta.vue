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
}>()

const tags = computed(() => props.tags ?? [])
const hasMeta = computed(() => !!props.owner || tags.value.length > 0)
</script>

<template>
  <div
    v-if="hasMeta"
    class="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-t border-default py-3.5"
  >
    <div v-if="owner" class="flex items-center gap-2">
      <UAvatar :text="ownerInitials(owner)" color="primary" size="sm" />
      <div class="leading-tight">
        <div class="text-[13px] font-medium text-highlighted">
          {{ owner }}
        </div>
        <div class="text-[11.5px] text-muted">
          Owner
        </div>
      </div>
    </div>

    <span v-if="owner && tags.length" class="hidden h-6 w-px bg-default sm:block" />

    <div v-if="tags.length" class="flex flex-wrap items-center gap-1">
      <UBadge
        v-for="tag in tags"
        :key="tag"
        color="neutral"
        variant="soft"
        size="xs"
      >
        {{ tag }}
      </UBadge>
    </div>
  </div>
</template>
