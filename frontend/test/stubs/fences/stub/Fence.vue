<script setup lang="ts">
import { onMounted, watch } from 'vue'
import type { FenceError } from '#shared/utils/fences'
import { check } from './server'

const props = defineProps<{
  source: string
  html?: string
  preview?: boolean
}>()

const emit = defineEmits<{
  error: [error: FenceError | null]
}>()

onMounted(() => emit('error', check(props.source)))
watch(() => props.source, source => emit('error', check(source)))
</script>

<template>
  <div
    class="stub-canvas"
    v-html="html"
  />
</template>
