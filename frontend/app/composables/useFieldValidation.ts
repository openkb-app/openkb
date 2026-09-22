import { getCurrentScope, onScopeDispose, ref, type ComputedRef, type Ref } from 'vue'
import type { FrontmatterFormField } from '~/editor/frontmatter-model'
import { TITLE_KEY, type FieldValues } from '~~/server/utils/entity-fields'

/** The dry-run response: per-field messages keyed by JSON:API field name. */
interface ValidateResponse {
  errors?: Record<string, string[]>
}

export interface FieldValidationOptions {
  nid: Ref<number>
  /** Render model — the key ↔ JSON:API-name mapping for exposed fields. */
  model: ComputedRef<FrontmatterFormField[]>
  /** Current session field values, frontmatter-keyed. */
  values: () => FieldValues
  /** Idle time before the pending keys are dry-run validated. */
  debounceMs?: number
  /** Request override for tests; defaults to the validate proxy route. */
  request?: (nid: number, fields: FieldValues) => Promise<ValidateResponse>
}

export interface FieldValidationApi {
  /**
   * Type-time state, frontmatter-keyed. A key is present once it has been
   * locally edited since the last {@link reset}; its value is the dry-run
   * messages, or `[]` while none are known. Merging this *over* the
   * commit-time (422) map makes an edit take a field's slot away from a
   * stale save-time message.
   */
  liveErrors: Ref<Record<string, string[]>>
  /** Report a local edit of one field: clears its slot, schedules a dry run. */
  touch: (key: string) => void
  /** Drop everything pending and shown (a fresh 422 is authoritative). */
  reset: () => void
}

/**
 * Debounced dry-run validation of locally edited fields (OKB-53).
 *
 * `touch(key)` is called from the local field-binding setter — never from
 * peer updates, so one edit costs one request no matter how many peers watch.
 * A touch clears the field's error slot immediately (the value changed; the
 * message no longer describes it) and schedules a validation of every key
 * touched within the idle window, batched into a single request.
 *
 * Responses are advisory: they only ever fill the slots of keys that were
 * *not* touched again while the request was in flight (per-key epochs), and a
 * failed request surfaces nothing — commit-time validation (OKB-48) is the
 * authority, this lane only front-runs its messages.
 */
export function useFieldValidation(options: FieldValidationOptions): FieldValidationApi {
  const debounceMs = options.debounceMs ?? 1000
  const request = options.request
    ?? ((nid: number, fields: FieldValues) =>
      $fetch<ValidateResponse>(`/api/node/${nid}/validate`, { method: 'POST', body: { fields } }))

  const liveErrors = ref<Record<string, string[]>>({})
  const pending = new Set<string>()
  const touchEpoch = new Map<string, number>()
  let timer: ReturnType<typeof setTimeout> | null = null

  function touch(key: string): void {
    touchEpoch.set(key, (touchEpoch.get(key) ?? 0) + 1)
    if (liveErrors.value[key]?.length !== 0) {
      liveErrors.value = { ...liveErrors.value, [key]: [] }
    }
    pending.add(key)
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, debounceMs)
  }

  function reset(): void {
    if (timer) clearTimeout(timer)
    timer = null
    pending.clear()
    touchEpoch.clear()
    liveErrors.value = {}
  }

  async function flush(): Promise<void> {
    timer = null
    const keys = [...pending]
    pending.clear()
    const sentEpoch = new Map(keys.map(key => [key, touchEpoch.get(key) ?? 0]))

    const nameByKey = new Map(options.model.value.map(f => [f.key, f.name]))
    nameByKey.set(TITLE_KEY, TITLE_KEY)
    const values = options.values()
    const fields: FieldValues = {}
    for (const key of keys) {
      const name = nameByKey.get(key)
      if (name) fields[name] = values[key] ?? null
    }
    if (Object.keys(fields).length === 0) return

    let response: ValidateResponse
    try {
      response = await request(options.nid.value, fields)
    }
    catch {
      // Advisory lane: an unreachable dry run shows nothing rather than a
      // scary error for a value that may be perfectly fine.
      return
    }

    const keyByName = new Map(options.model.value.map(f => [f.name, f.key]))
    keyByName.set(TITLE_KEY, TITLE_KEY)
    const messagesByKey: Record<string, string[]> = {}
    for (const [name, messages] of Object.entries(response.errors ?? {})) {
      const key = keyByName.get(name)
      if (key && messages.length > 0) messagesByKey[key] = messages
    }

    const next = { ...liveErrors.value }
    for (const key of keys) {
      // A key touched again while the request was in flight is stale here —
      // its own rescheduled dry run owns the slot.
      if ((touchEpoch.get(key) ?? 0) !== sentEpoch.get(key)) continue
      next[key] = messagesByKey[key] ?? []
    }
    liveErrors.value = next
  }

  if (getCurrentScope()) {
    onScopeDispose(() => {
      if (timer) clearTimeout(timer)
    })
  }

  return { liveErrors, touch, reset }
}
