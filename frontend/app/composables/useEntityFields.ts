import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type Ref,
  type WritableComputedRef,
} from 'vue'
import { FALLBACK_COLOR, FALLBACK_NAME } from '#shared/utils/presence'
import type * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import type { FieldValue, FieldValues } from '~~/server/utils/entity-fields'

export type { EntityRef, FieldValue, FieldValues } from '~~/server/utils/entity-fields'

/** A peer currently editing a field, as carried in the awareness state. */
export interface FieldPeer {
  clientId: number
  name: string
  color: string
}

export interface EntityFieldsOptions {
  /** The session Y.Doc — the same instance the editor and provider share. */
  ydoc: Y.Doc
  /** Provider whose awareness carries the per-field editing signal. */
  provider?: Ref<HocuspocusProvider | null>
  /** Identity published with this client's awareness state. */
  user?: { name: string, color: string }
}

/**
 * Reactive bindings for the session's entity fields — the `fields` Y.Map.
 *
 * The map is seeded server-side from Drupal (server/utils/doc-seed.ts) before
 * the client syncs, so a field appears here exactly when it is placed in the
 * `frontmatter` form display. Nothing in this composable knows a field name.
 *
 * Merge semantics come from Y.Map itself: every write replaces one whole key,
 * so concurrent edits to different fields both survive and concurrent edits to
 * the same field resolve last-writer-wins with every peer converging on the
 * same value. Multi-value fields are stored as plain arrays and written whole
 * for the same reason — an array mutated in place would have no merge identity.
 *
 * Awareness carries `editingField`, so peers can be shown per field rather
 * than only in the body (where CollaborationCaret already places them). It is
 * a hint, not a lock: two peers may edit one field, and LWW settles it.
 */
export function useEntityFields(options: EntityFieldsOptions) {
  const fieldsMap = options.ydoc.getMap('fields')
  const fields = ref<FieldValues>(readFields())
  const peersByField = ref<Record<string, FieldPeer[]>>({})
  /** False until the server-side seed has arrived — the form has no fields to render yet. */
  const seeded = computed(() => Object.keys(fields.value).length > 0)

  function readFields(): FieldValues {
    return Object.fromEntries(fieldsMap.entries()) as FieldValues
  }

  const onFields = () => { fields.value = readFields() }

  /**
   * Writes one key. No-ops on an unchanged value so a round-tripped remote
   * update — observer → ref → input → back here — does not re-broadcast and
   * hand the field back to this client on every peer edit.
   */
  function setField(key: string, value: FieldValue): void {
    if (JSON.stringify(fieldsMap.get(key) ?? null) === JSON.stringify(value ?? null)) return
    fieldsMap.set(key, value)
  }

  // Memoized: a template binds `field(key)` inside its render, and a fresh
  // computed per render would drop its cache on every peer update.
  const models = new Map<string, WritableComputedRef<FieldValue>>()

  /** `v-model` binding for one field. */
  function field(key: string): WritableComputedRef<FieldValue> {
    let model = models.get(key)
    if (!model) {
      model = computed({
        get: () => fields.value[key] ?? null,
        set: value => setField(key, value),
      })
      models.set(key, model)
    }
    return model
  }

  const awareness = computed(() => options.provider?.value?.awareness ?? null)

  function readPeers(): void {
    const states = awareness.value?.getStates()
    const localId = awareness.value?.clientID
    const grouped: Record<string, FieldPeer[]> = {}
    for (const [clientId, state] of states?.entries() ?? []) {
      if (clientId === localId) continue
      const key = (state as { editingField?: string })?.editingField
      if (!key) continue
      const user = (state as { user?: { name?: string, color?: string } })?.user ?? {}
      ;(grouped[key] ??= []).push({
        clientId,
        name: user.name ?? FALLBACK_NAME,
        color: user.color ?? FALLBACK_COLOR,
      })
    }
    peersByField.value = grouped
  }

  /** Announce which field this client has focused (null on blur). */
  function focusField(key: string | null): void {
    const aw = awareness.value
    if (!aw) return
    if (options.user) aw.setLocalStateField('user', options.user)
    aw.setLocalStateField('editingField', key)
  }

  onMounted(() => {
    fieldsMap.observe(onFields)
    onFields()
    // The provider is created in useLiveCollab's own onMounted, so its
    // awareness only exists from the next tick — watch rather than read once.
    watch(awareness, (aw, _prev, onCleanup) => {
      if (!aw) return
      aw.on('change', readPeers)
      readPeers()
      onCleanup(() => aw.off('change', readPeers))
    }, { immediate: true })
  })

  onBeforeUnmount(() => {
    fieldsMap.unobserve(onFields)
    awareness.value?.setLocalStateField('editingField', null)
  })

  return { fields, seeded, field, setField, peersByField, focusField }
}
