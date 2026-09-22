<script setup lang="ts">
/**
 * Space chooser over the spaces the session can see (`GET /api/spaces`).
 *
 * Shared by the two surfaces that name a space deliberately: creating a page
 * from a context that has none (the home CTA), and moving a page to another
 * space. It never appears inside the frontmatter form — a space is context, not
 * a field of the document (OKB-63).
 *
 * The model value is the space UUID, which is what both write endpoints take.
 */
import type { SpaceOption } from '~/composables/useSpaceOptions'

const model = defineModel<string | undefined>()

const props = defineProps<{
  /** Spaces to offer. Fetched by the parent so it can also resolve names. */
  spaces: SpaceOption[]
  disabled?: boolean
  /** Space UUID to leave out — the one the page already lives in. */
  exclude?: string | null
  placeholder?: string
}>()

const items = computed(() =>
  props.spaces
    .filter(space => space.id !== props.exclude)
    .map(space => ({ label: space.name, value: space.id })),
)
</script>

<template>
  <USelect
    v-model="model"
    :items="items"
    value-key="value"
    :disabled="disabled || !items.length"
    :placeholder="placeholder ?? 'Choose a space…'"
    icon="i-lucide-folder"
    size="sm"
    class="w-full"
    data-testid="space-picker"
  />
</template>
