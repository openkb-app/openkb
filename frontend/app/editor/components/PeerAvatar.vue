<script setup lang="ts">
// Explicit, not auto-imported: the components around it are rendered by their
// own vitest suites outside a Nuxt app.
import { computed } from 'vue'
import { initialsOf, readableInkOn } from '#shared/utils/presence'

/**
 * One peer's avatar — initials in their identity colour, and the robot mark an
 * agent wears. Every surface that shows a peer draws it through this, so an
 * agent is recognisable as one wherever it is named.
 *
 * An agent carries its owner's initials in the mint the brand reserves for
 * agent attribution: the name beside it says which agent, the initials say
 * whose, and the colour says it is an agent and not the person.
 */
const props = defineProps<{
  /** The account behind the peer. */
  name: string
  /** Identity colour, where the surface has one. */
  color?: string | null
  /** The client label — set on an agent, absent on a person. */
  via?: string | null
  /** Passed to `UAvatar`; the group around it decides when left out. */
  size?: string
}>()

const ink = computed(() => (props.color ? readableInkOn(props.color) : undefined))
const tint = computed(() =>
  (!props.via && props.color ? { backgroundColor: props.color, color: ink.value } : undefined))
</script>

<template>
  <span class="relative inline-flex">
    <!-- The theme's `fallback` slot carries `text-muted`; `text-current` hands it the root's ink. -->
    <UAvatar
      :size="size"
      :text="initialsOf(name)"
      :class="via ? 'okb-agent-avatar' : undefined"
      :style="tint"
      :ui="{ fallback: 'text-current' }"
    />
    <!-- 55% of the avatar, offset 13% of it, ringed in the surface colour. -->
    <span
      v-if="via"
      class="absolute -end-[13%] -bottom-[13%] inline-flex size-[55%] items-center justify-center rounded-full ring-[1.5px] ring-(--ui-bg) bg-neutral-800 dark:bg-neutral-950 text-primary-300"
      data-testid="agent-badge"
      aria-hidden="true"
    >
      <UIcon name="sidekickicons:robot-20-solid" class="size-[85%]" />
    </span>
  </span>
</template>
