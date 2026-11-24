<script setup lang="ts">
// The line a printed page carries under its title: where it lives and which
// version is on the paper. Print only (print.css shows `.okb-print-meta`).
import { absoluteDate, changedToMs } from '#shared/utils/kb-meta'

const props = defineProps<{
  spaceName?: string
  changed?: string | number
  /** The version shown was never published. */
  draft?: boolean
}>()

const route = useRoute()
const date = computed(() => absoluteDate(changedToMs(props.changed)))
</script>

<template>
  <p class="okb-print-meta hidden" data-testid="page-print-meta">
    <template v-if="spaceName">{{ spaceName }} · </template>{{ route.path }}
    <template v-if="date"> · {{ date }}</template>
    <strong v-if="draft"> · Draft — not published</strong>
  </p>
</template>
