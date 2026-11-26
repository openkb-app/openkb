<script setup lang="ts">
// The line a printed page carries under its title: where it lives and which
// version is on the paper. In a print render only.
import { absoluteDate, changedToMs } from '#shared/utils/kb-meta'

const props = defineProps<{
  spaceName?: string
  path: string
  changed?: string | number
  /** The version shown is not a published one. */
  draft?: boolean
}>()

const date = computed(() => absoluteDate(changedToMs(props.changed)))
</script>

<template>
  <p class="hidden print:mb-[14pt] print:block print:text-[9pt] print:text-[#4b5563]" data-testid="page-print-meta">
    <template v-if="spaceName">{{ spaceName }} · </template>{{ path }}
    <template v-if="date"> · {{ date }}</template>
    <strong v-if="draft"> · Draft — not published</strong>
  </p>
</template>
