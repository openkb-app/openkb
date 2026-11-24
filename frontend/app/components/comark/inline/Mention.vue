<script setup lang="ts">
import { computed, inject, onMounted } from 'vue'
import { ownedLabel } from '#shared/utils/attribution'
import { VIEWER_UID, accountName, accountUnknown, requestAccountName } from '../../../composables/useAccountNames'

/**
 * A mention of a user, `:mention[label]{uid="N"}`, or of an agent of theirs,
 * `{uid="N" via="label"}`: the same chip markup as the editor's mention node
 * (`app/editor/nodes/mention.ts`), `data-label` included, so a chip pasted
 * into the editor keeps its label. The tree pass sets `label` from the
 * mention's words.
 *
 * - The chip names the account as it is called now; an agent's owner reads
 *   the agent's label alone.
 * - The label it was written with shows until that is known (server render
 *   included).
 * - An account the lookup does not know (gone, or hidden from the reader) is
 *   no chip: its stored words read as plain text.
 */
const props = defineProps<{
  /** @notIndexed */
  uid?: string
  /** @notIndexed */
  via?: string
  /** @render */
  label?: string
  /** @render */
  inline?: boolean
}>()

const viewerUid = inject(VIEWER_UID, null)

onMounted(() => requestAccountName(Number(props.uid)))

const current = computed(() => {
  const uid = Number(props.uid)
  const name = accountName(uid)
  if (name === undefined) return undefined
  return ownedLabel({ uid, name, via: props.via || null }, viewerUid?.value)
})

const unknown = computed(() => accountUnknown(Number(props.uid)))
</script>

<template>
  <span v-if="unknown">@<slot /></span>
  <span
    v-else
    class="mention"
    :class="{ 'mention--agent': via }"
    data-type="mention"
    :data-id="uid"
    :data-label="label || undefined"
  >@<template v-if="current">{{ current }}</template><slot v-else /></span>
</template>
