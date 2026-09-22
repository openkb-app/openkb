import * as Y from 'yjs'
import { serverMessage } from '~/utils/api-error'

export type CommitStatus = 'never-saved' | 'dirty' | 'saving' | 'saved' | 'error'

export interface ExternalChange {
  expected: number
  actual: number
}

export interface CommitStateOptions {
  ydoc: Y.Doc
  nid: number | Ref<number>
  initialChanged: number | Ref<number>
}

/**
 * Drupal-side commit lane — separate from the live Y.Doc/WS lane.
 *
 * Save is a thin RPC: POST /api/node/<nid>/commit. The server serializes the
 * live Y.Doc and PATCHes Drupal — there is no client-side serialization. The
 * server also writes the outcome into `_meta`, so every connected client sees
 * the same Drupal-history state without out-of-band signals:
 *
 *   _meta.drupal_changed    — latest committed `changed` from any commit
 *   _meta.last_save_at      — clock for "Saved Xs ago" everywhere
 *   _meta.last_commit       — confirmed-checkpoint signal (mirror clear)
 *   _meta.commit_error      — last failed commit; its `fields` map (keyed by
 *                             JSON:API field name) drives the FrontmatterForm's
 *                             per-field error slots on every peer
 *   _meta.external_change_detected — set when Drupal refuses a commit as
 *                                    stale (409), i.e. Drupal moved
 */
export function useDrupalCommitState(opts: CommitStateOptions) {
  const status = ref<CommitStatus>('never-saved')
  const error = ref<string | null>(null)
  const lastChanged = ref<number>(typeof opts.initialChanged === 'number' ? opts.initialChanged : opts.initialChanged.value)
  const lastSavedAt = ref<number | null>(null)
  const externalChange = ref<ExternalChange | null>(null)
  /** Per-field validation messages from the last failed commit, JSON:API-name-keyed. */
  const commitFieldErrors = ref<Record<string, string[]>>({})

  // Backfill once if `initialChanged` is a Ref that resolves after setup
  // (used by `useEditorSession`, which kicks off useFetch synchronously
  // but resolves the page data asynchronously).
  if (typeof opts.initialChanged !== 'number') {
    const initRef = opts.initialChanged
    const stop = watch(initRef, (v) => {
      if (lastChanged.value === 0 && v) {
        lastChanged.value = v
        stop()
      }
    }, { immediate: true })
  }

  const meta = opts.ydoc.getMap('_meta')

  const onMeta = () => {
    // (a) Someone in the session saved — every peer learns about it.
    const newChanged = Number(meta.get('drupal_changed') ?? 0)
    if (newChanged > lastChanged.value) {
      lastChanged.value = newChanged
      lastSavedAt.value = Number(meta.get('last_save_at') ?? Date.now())
      // Don't override our own in-flight save or unflushed local edits.
      if (status.value !== 'saving' && status.value !== 'dirty') {
        status.value = 'saved'
      }
    }
    // (b) A commit hit Drupal's stale check — an external write landed during
    // the session. Written by whichever peer's commit was refused, so every
    // peer raises the banner, not just the one that pressed Save.
    const ext = meta.get('external_change_detected') as
      { actual: number, at: number } | undefined
    if (ext && Number(ext.actual) > lastChanged.value) {
      if (!externalChange.value || externalChange.value.actual !== Number(ext.actual)) {
        externalChange.value = { expected: lastChanged.value, actual: Number(ext.actual) }
      }
    }
    else if (!ext && externalChange.value) {
      externalChange.value = null
    }
    // (c) A commit failed validation (this client's or any peer's) — mirror
    // the per-field messages; a successful commit deletes commit_error and
    // this clears them everywhere.
    const commitErr = meta.get('commit_error') as { fields?: Record<string, string[]> } | undefined
    const fieldErrors = commitErr?.fields ?? {}
    if (JSON.stringify(fieldErrors) !== JSON.stringify(commitFieldErrors.value)) {
      commitFieldErrors.value = fieldErrors
    }
  }

  onMounted(() => meta.observeDeep(onMeta))
  onBeforeUnmount(() => meta.unobserveDeep(onMeta))

  function markDirty() {
    if (status.value === 'saved' || status.value === 'never-saved') {
      status.value = 'dirty'
    }
  }

  async function save() {
    if (status.value === 'saving') return

    status.value = 'saving'
    error.value = null
    try {
      const nid = typeof opts.nid === 'number' ? opts.nid : opts.nid.value
      // The server serializes the live Y.Doc and PATCHes Drupal, then writes
      // drupal_changed / last_save_at / last_commit into `_meta` — which the
      // observer above mirrors to every peer. We only reflect our own outcome.
      const res = await $fetch<{ nid: number, ok: boolean, committed: boolean, changed?: number }>(
        `/api/node/${nid}/commit`,
        { method: 'POST' },
      )
      if (typeof res.changed === 'number') lastChanged.value = res.changed
      lastSavedAt.value = Date.now()
      status.value = 'saved'
    }
    catch (err: unknown) {
      const e = err as { statusCode?: number, data?: { expected?: number, actual?: number }, message?: string }
      if (e?.statusCode === 409 && e?.data?.expected !== undefined && e?.data?.actual !== undefined) {
        externalChange.value = { expected: e.data.expected, actual: e.data.actual }
        error.value = 'External change'
      }
      else {
        // The chip carries the server's own sentence — a validation refusal
        // names the field it is about.
        error.value = serverMessage(err) ?? e?.message ?? String(err)
      }
      status.value = 'error'
    }
  }

  return { status, error, lastChanged, lastSavedAt, externalChange, commitFieldErrors, markDirty, save }
}
