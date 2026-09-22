<script setup lang="ts">
/**
 * Entity-reference autocomplete: the frontmatter form's reference fields, and
 * the search page's Author filter.
 *
 * Renders a combobox whose options are fetched from /api/entity-autocomplete
 * as the user types (server-side filtering — `ignore-filter`), and whose value
 * is the `{ id, label }` shape the `fields` Y.Map stores. `by="id"` so a
 * selected ref stays highlighted across refetches even though each fetch
 * returns fresh option objects.
 *
 * The reference target (entity type + bundles) comes from the schema's
 * `x-entity-reference`; a term reference is addressed per-vocabulary, so the
 * first bundle is used as the JSON:API bundle segment.
 */
import type { EntityRef } from '~/composables/useEntityFields'
import type { FrontmatterReferenceTarget } from '~/editor/frontmatter-model'

const props = defineProps<{
  modelValue: EntityRef | EntityRef[] | null
  reference: FrontmatterReferenceTarget
  multiple: boolean
  placeholder?: string
  inputId?: string
  invalid?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [EntityRef | EntityRef[] | null] }>()

const items = ref<EntityRef[]>([])
const loading = ref(false)
const searchTerm = ref('')

/** Single-select wants object|undefined; multi wants an array. */
const selected = computed<EntityRef | EntityRef[] | undefined>({
  get() {
    if (props.multiple) return Array.isArray(props.modelValue) ? props.modelValue : []
    return (props.modelValue as EntityRef | null) ?? undefined
  },
  set(value) {
    if (props.multiple) emit('update:modelValue', (value as EntityRef[]) ?? [])
    else emit('update:modelValue', (value as EntityRef | undefined) ?? null)
  },
})

/**
 * Keeps the current selection in the option list so `by="id"` can resolve its
 * label before (or without) a search — otherwise a seeded value would show as
 * an unmatched id until the user typed.
 */
function withSelection(results: EntityRef[]): EntityRef[] {
  const current = props.multiple
    ? (Array.isArray(props.modelValue) ? props.modelValue : [])
    : (props.modelValue ? [props.modelValue as EntityRef] : [])
  const seen = new Set(results.map(r => r.id))
  return [...results, ...current.filter(ref => ref && !seen.has(ref.id))]
}

let timer: ReturnType<typeof setTimeout> | null = null
let controller: AbortController | null = null

async function runSearch(q: string) {
  if (controller) controller.abort()
  if (!q) { items.value = withSelection([]); return }
  controller = new AbortController()
  loading.value = true
  try {
    const params = new URLSearchParams({ entity_type: props.reference.entityType, q })
    const bundle = props.reference.bundles[0]
    if (bundle) params.set('bundle', bundle)
    const res = await fetch(`/api/entity-autocomplete?${params.toString()}`, {
      signal: controller.signal,
      credentials: 'same-origin',
    })
    if (!res.ok) { items.value = withSelection([]); return }
    const data = await res.json() as { results?: EntityRef[] }
    items.value = withSelection(data.results ?? [])
  }
  catch { /* aborted or network — leave the last options in place */ }
  finally { loading.value = false }
}

watch(searchTerm, (q) => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => runSearch(q.trim()), 150)
})

// Seed the option list with the current value so its label renders on mount.
onMounted(() => { items.value = withSelection([]) })

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
  if (controller) controller.abort()
})
</script>

<template>
  <UInputMenu
    :id="inputId"
    v-model="selected"
    v-model:search-term="searchTerm"
    :items="items"
    :multiple="multiple"
    :loading="loading"
    by="id"
    label-key="label"
    ignore-filter
    :placeholder="placeholder"
    size="sm"
    icon="i-lucide-search"
    :highlight="invalid"
    :color="invalid ? 'error' : undefined"
    class="w-full"
  >
    <template #empty>
      <span class="text-[12px] text-muted">
        {{ searchTerm ? 'No matches.' : 'Type to search…' }}
      </span>
    </template>
  </UInputMenu>
</template>
