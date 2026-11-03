<script setup lang="ts">
// Which version a revision page shows: its moment, state, author and log line.
import { absoluteDateTime } from '#shared/utils/kb-meta'
import { stateLabel } from '#shared/utils/moderation'
// Relative: the SFC type resolver does not read Nuxt's aliases.
import type { RevisionProps } from '../../utils/revision-history'

const props = defineProps<{ revision: RevisionProps }>()

const when = computed(() => {
  const ms = Date.parse(props.revision.created)
  return absoluteDateTime(Number.isNaN(ms) ? null : ms)
})
const stateText = computed(() => stateLabel(props.revision.state))
</script>

<template>
  <div
    class="mb-5 rounded-md border border-default bg-elevated/50 px-3 py-2 text-[13px] text-toned"
    data-testid="revision-notice"
  >
    <p>
      Version of <strong class="text-highlighted">{{ when }}</strong>
      <template v-if="stateText"> · {{ stateText }}</template>
      <template v-if="revision.author"> · {{ revision.author }}</template>
    </p>
    <p v-if="revision.log" class="mt-1 text-muted">
      {{ revision.log }}
    </p>
  </div>
</template>
