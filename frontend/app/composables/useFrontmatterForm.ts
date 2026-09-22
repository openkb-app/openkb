import { computed, ref, type ComputedRef, type Ref, type WritableComputedRef } from 'vue'
import { toFormModel, type FrontmatterFormField, type FrontmatterSchema } from '~/editor/frontmatter-model'
import type { FieldPeer } from '~/composables/useEntityFields'
import type { FieldValue } from '~~/server/utils/entity-fields'

/**
 * Bindings the form shares with the live session — the `fields` Y.Map side of
 * the seam (OKB-46). The form owns none of these; it renders through them.
 */
export interface EntityFieldBindings {
  /** True once the server-side seed has populated the `fields` map. */
  seeded: ComputedRef<boolean>
  /** `v-model` binding for one field key, LWW-merged across peers. */
  field: (key: string) => WritableComputedRef<FieldValue>
  /** Peers currently focused on each field, from awareness. */
  peersByField: Ref<Record<string, FieldPeer[]>>
  /** Announce this client's focused field (null on blur). */
  focusField: (key: string | null) => void
}

/**
 * Everything the FrontmatterForm needs, assembled once per editor session.
 *
 * The render model comes from the schema (`/api/openkb/schema` → toFormModel);
 * the bindings come from the live session. `errors` is the per-field
 * validation lane, fed by the commit path's 422 mapping (useEditorSession
 * translates `_meta.commit_error.fields` from JSON:API field names to
 * frontmatter keys) and cleared on the next successful commit.
 */
export interface FrontmatterFormApi extends EntityFieldBindings {
  /** Ordered render descriptors, or `[]` until the schema resolves. */
  model: ComputedRef<FrontmatterFormField[]>
  /** Schema fetch in flight. */
  pending: Ref<boolean>
  /** Schema fetch failed — truthy drives the branded ErrorState. */
  error: Ref<unknown>
  /** Status class the ErrorState renders (OKB-44): 404 / 403 / 503. */
  errorStatus: ComputedRef<number>
  /** Per-field validation messages, keyed by field key. */
  errors: Ref<Record<string, string[]>>
  /** Re-fetch the schema (the ErrorState retry action). */
  refresh: () => Promise<void>
}

/**
 * Fetches the frontmatter schema and joins it to the session's field bindings.
 *
 * MUST be called before the surrounding setup's first `await` — useFetch
 * registers Nuxt's async-data context synchronously, which does not survive an
 * await boundary inside a nested composable.
 */
export function useFrontmatterForm(bindings: EntityFieldBindings): FrontmatterFormApi {
  const { data, pending, error, refresh } = useFetch<FrontmatterSchema>('/api/openkb/schema', {
    // Shared across every editor page — key it so a second mount reuses the
    // payload instead of refetching the exposure contract.
    key: 'openkb-frontmatter-schema',
    default: () => ({ properties: {} }),
  })

  const model = computed(() => toFormModel(data.value))
  const errorStatus = computed(
    () => Number((error.value as { statusCode?: number } | null)?.statusCode) || 503,
  )
  const errors = ref<Record<string, string[]>>({})

  return {
    model,
    pending,
    error,
    errorStatus,
    errors,
    refresh,
    seeded: bindings.seeded,
    field: bindings.field,
    peersByField: bindings.peersByField,
    focusField: bindings.focusField,
  }
}
