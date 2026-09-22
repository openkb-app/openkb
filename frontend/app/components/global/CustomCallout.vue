<script setup lang="ts">
interface Props {
  type?: 'info' | 'warning' | 'success' | 'danger'
}

const props = withDefaults(defineProps<Props>(), { type: 'info' })

const tone = computed(() => {
  switch (props.type) {
    case 'warning':
      return { ring: 'ring-amber-300 dark:ring-amber-700', bg: 'bg-amber-50 dark:bg-amber-950/40', text: 'text-amber-900 dark:text-amber-100', icon: 'i-lucide-triangle-alert' }
    case 'success':
      return { ring: 'ring-emerald-300 dark:ring-emerald-700', bg: 'bg-emerald-50 dark:bg-emerald-950/40', text: 'text-emerald-900 dark:text-emerald-100', icon: 'i-lucide-circle-check' }
    case 'danger':
      return { ring: 'ring-red-300 dark:ring-red-700', bg: 'bg-red-50 dark:bg-red-950/40', text: 'text-red-900 dark:text-red-100', icon: 'i-lucide-circle-x' }
    case 'info':
    default:
      return { ring: 'ring-sky-300 dark:ring-sky-700', bg: 'bg-sky-50 dark:bg-sky-950/40', text: 'text-sky-900 dark:text-sky-100', icon: 'i-lucide-info' }
  }
})
</script>

<template>
  <div
    data-test="callout"
    class="my-4 rounded-lg ring-1 px-4 py-3 flex gap-3"
    :class="[tone.ring, tone.bg, tone.text]"
  >
    <UIcon :name="tone.icon" class="mt-0.5 size-5 shrink-0" />
    <!-- The body needs a box of its own, or every block in it becomes a flex
         item beside the icon. -->
    <div class="okb-box-body okb-prose-compact min-w-0 flex-1">
      <slot />
    </div>
  </div>
</template>
