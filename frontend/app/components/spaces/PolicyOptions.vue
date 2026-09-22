<script setup lang="ts" generic="T extends string | boolean">
/**
 * A single-choice list of policy options — the shared control behind every
 * space policy setting.
 *
 * One presentation, two homes: the create dialog picks a policy into a local
 * value, and the space settings cards bind it straight to a save. That is the
 * point of extracting it — putting the same option list in both by hand would
 * be the "second copy of a surface that exists" this deliberately avoids.
 *
 * Each option is a real `<button>` with a visible focus ring and `aria-pressed`
 * for the current choice; picking one that is already current is a no-op.
 */
interface PolicyOption {
  value: T
  label: string
  icon: string
  hint: string
  /** data-testid for this option's button, so callers keep their contract. */
  testid?: string
}

const props = defineProps<{
  modelValue: T
  options: PolicyOption[]
  disabled?: boolean
  /** Names the group for assistive tech (the section heading is separate). */
  ariaLabel?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [T] }>()

function choose(value: T) {
  if (props.disabled || value === props.modelValue) return
  emit('update:modelValue', value)
}
</script>

<template>
  <div class="flex flex-col gap-2" role="group" :aria-label="ariaLabel">
    <button
      v-for="option in options"
      :key="String(option.value)"
      type="button"
      :disabled="disabled"
      :aria-pressed="modelValue === option.value"
      :data-testid="option.testid"
      class="flex items-start gap-3 rounded-md px-3 py-2 text-left transition hover:bg-(--ui-bg-muted) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ui-primary) disabled:opacity-60"
      :class="modelValue === option.value ? 'bg-(--ui-bg-muted) shadow-[0_0_0_1px_var(--ui-border)]' : ''"
      @click="choose(option.value)"
    >
      <UIcon :name="option.icon" class="mt-[3px] size-[14px] text-muted" />
      <span class="flex flex-col gap-0.5">
        <span class="text-[13.5px] font-medium text-highlighted">{{ option.label }}</span>
        <span class="text-[12.5px] text-muted">{{ option.hint }}</span>
      </span>
    </button>
  </div>
</template>
