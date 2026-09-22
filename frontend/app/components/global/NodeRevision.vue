<script setup lang="ts">
// One `node-revision` element: a row of the version history. Read-only, and
// every field is something Drupal recorded — nothing is derived from another
// row, so a row means the same thing wherever it sits.
import { absoluteDate, lastUpdatedLabel } from '#shared/utils/kb-meta'
// Relative, not `~/utils/…`: the props interface is resolved by the SFC
// compiler's own type resolver, which does not read Nuxt's aliases, and
// `defineProps<RevisionProps>()` fails the build on an aliased import.
import { revisionMarkers, type RevisionProps } from '../../utils/revision-history'
import { stateLabel } from '#shared/utils/moderation'

const props = defineProps<RevisionProps>()

const markers = computed(() => revisionMarkers(props))
const stateText = computed(() => stateLabel(props.state))

const createdMs = computed(() => {
  const ms = Date.parse(props.created)
  return Number.isNaN(ms) ? null : ms
})

// The app's own last-updated vocabulary. The bucket comes from an epoch
// difference, so server-rendered and hydrating client agree whatever zone each
// is in; the exact moment is in the tooltip.
const now = Date.now()
const whenLabel = computed(() => lastUpdatedLabel(createdMs.value, now))
const whenTitle = computed(() => absoluteDate(createdMs.value) ?? undefined)
</script>

<template>
  <li class="py-3" :data-revision="vid">
    <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span class="text-sm text-highlighted">
        <NuxtLink
          v-if="author && authorUid"
          :to="`/user/${authorUid}`"
          class="underline underline-offset-2 hover:text-primary"
        >
          {{ author }}
        </NuxtLink>
        <template v-else-if="author">{{ author }}</template>
        <!-- An account that is gone is not an anonymous edit: say the record
             lost the name rather than attributing it to nobody. -->
        <template v-else>Author no longer on record</template>
      </span>
      <span v-if="whenLabel" class="text-[12.5px] text-muted" :title="whenTitle">
        {{ whenLabel }}
      </span>
      <span v-if="stateText" class="text-[12.5px] text-dimmed">
        · {{ stateText }}
      </span>
      <span class="ml-auto flex items-center gap-1">
        <UBadge
          v-for="marker in markers"
          :key="marker.label"
          :color="marker.color"
          variant="subtle"
          size="sm"
          :icon="marker.icon"
        >
          {{ marker.label }}
        </UBadge>
      </span>
    </div>
    <p v-if="log" class="mt-1 text-[13px] text-toned">
      {{ log }}
    </p>
  </li>
</template>
