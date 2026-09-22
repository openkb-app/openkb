import { serverMessage } from '~/utils/api-error'
import type { ModerationStatus } from '#shared/utils/moderation'
import type { ReviewStep } from '#shared/page-blocks'

/** One change the publish gate refused over, as Drupal named it. */
export interface PublishBlocker {
  /** The sidecar key: a block id, a removed block's id, or `field:title`. */
  item: string
  steps: ReviewStep[]
  detail?: string
}

/** A JSON:API error object as the gate's 422 carries it (server/utils/upstream). */
interface GateViolation {
  detail?: string
  source?: { pointer?: string }
  meta?: { item?: string, steps?: string[] }
}

/**
 * The changes named by a refused publish.
 *
 * The gate answers with one error object per blocking change — its sidecar key
 * in `meta.item` (and `source.pointer`), the steps it owes in `meta.steps` —
 * which rides through the Nitro layer verbatim (moderationWriteError). An item
 * is a block, a removed block, or a reviewed field (ADR 0017). This is the
 * AUTHORITATIVE list: the client's own derivation reads a sidecar that is one
 * checkpoint behind, and the publish endpoint checkpoints before it refuses,
 * so a block the editor just typed into appears here and nowhere else.
 *
 * Read at both depths, as NewPageButton reads its own violations: `$fetch`
 * hands the whole error BODY over as `err.data`, and h3 nests what
 * `createError` was given under a `data` key of that body — so the list
 * arrives one level deeper than the server wrote it.
 */
export function publishBlockersOf(err: unknown): PublishBlocker[] {
  const body = (err as {
    data?: { violations?: GateViolation[], data?: { violations?: GateViolation[] } }
  })?.data
  const violations = body?.data?.violations ?? body?.violations ?? []
  return violations
    .filter((v): v is GateViolation & { meta: { item: string } } => !!v.meta?.item)
    .map(v => ({
      item: v.meta.item,
      steps: (v.meta.steps ?? []) as ReviewStep[],
      detail: v.detail,
    }))
}

/** The HTTP status an ofetch rejection carries, at either depth h3 nests it. */
function statusCodeOf(err: unknown): number | undefined {
  const e = err as { statusCode?: number, status?: number, data?: { statusCode?: number } }
  return e?.statusCode ?? e?.status ?? e?.data?.statusCode
}

/**
 * The page's moderation status and the two actions that change it (OKB-84).
 *
 * Fetched on the client after mount, and only when the session may edit: the
 * route requires node-update access. Publish and Revert adopt the status their
 * own response returns.
 */
export function useModerationStatus(nid: Ref<number | undefined>, enabled: Ref<boolean>) {
  const status = ref<ModerationStatus | null>(null)
  /** Which action is in flight, so the chrome can show exactly one spinner. */
  const busy = ref<'publish' | 'revert' | null>(null)
  /**
   * The changes the last publish was refused over — the gate's own answer.
   * Cleared by the next attempt, so it always describes the latest one.
   */
  const publishBlockers = ref<PublishBlocker[]>([])
  const requestFetch = useRequestFetch()
  const toast = useToast()

  /** Read counter. A slow earlier read must not overwrite a later answer. */
  let latest = 0

  async function refresh(): Promise<void> {
    const id = nid.value
    const read = ++latest
    if (!id || !enabled.value) {
      status.value = null
      return
    }
    try {
      // The forwarding route is JSON-only and ofetch sends `Accept` only with
      // a body, so a GET has to name it.
      const fresh = await requestFetch<ModerationStatus>(`/api/drupal/openkb/node/${id}/moderation`, {
        headers: { Accept: 'application/json' },
      })
      if (read === latest) status.value = fresh
    }
    catch (err) {
      // 403 is the normal answer for a reader: `node.update` is per space, so
      // a session that may edit elsewhere is still refused here.
      if (statusCodeOf(err) !== 403) console.error('[kb-page] moderation status unavailable:', err)
      if (read === latest) status.value = null
    }
  }

  onMounted(() => { void refresh() })
  watch([nid, enabled], () => { void refresh() })

  /**
   * Runs one moderation action, adopting the status it answers with.
   *
   * The endpoints return the post-write status, so the badge updates from the
   * same round trip that performed the change — no refetch, no window in which
   * the chrome describes the state the page was in a moment ago.
   */
  async function run(
    action: 'publish' | 'revert',
    success: { title: string, description: string },
  ): Promise<boolean> {
    const id = nid.value
    if (!id || busy.value) return false
    busy.value = action
    if (action === 'publish') publishBlockers.value = []
    try {
      const result = await requestFetch<{ status: ModerationStatus }>(`/api/node/${id}/${action}`, {
        method: 'POST',
      })
      // The write's own answer wins over any read still in flight.
      latest++
      status.value = result.status
      toast.add({ ...success, icon: 'i-lucide-check', color: 'success' })
      return true
    }
    catch (err) {
      const message = serverMessage(err) ?? 'Please try again.'
      // A 422 is the page not being ready, not the person being refused:
      // it reads as a state, and the blocks it names are kept for the drawer
      // the caller opens on them.
      const blockers = action === 'publish' ? publishBlockersOf(err) : []
      const held = action === 'publish' && (blockers.length > 0 || statusCodeOf(err) === 422)
      if (!held) console.error(`[kb-page] ${action} failed:`, err)
      publishBlockers.value = blockers
      // A hold Drupal named no item for is structural — its sentence is the
      // whole answer, and it is the one the reader can act on.
      const hold = blockers.length === 0
        ? { title: 'Publishing is on hold', description: message, icon: 'i-lucide-clock' }
        : {
            title: blockers.length === 1
              ? 'One change is still waiting for review'
              : `${blockers.length} changes are still waiting for review`,
            description: 'The page publishes once every change has been signed off.',
            icon: 'i-lucide-eye',
          }
      toast.add(held
        ? { ...hold, color: 'warning' as const }
        : {
            title: action === 'publish' ? 'Publish failed' : 'Revert failed',
            description: message,
            icon: 'i-lucide-triangle-alert',
            color: 'error' as const,
          })
      // The write may have half-landed (the checkpoint before it can succeed
      // while the transition is refused), so re-read rather than assume.
      await refresh()
      return false
    }
    finally {
      busy.value = null
    }
  }

  return {
    status,
    busy,
    publishBlockers,
    refresh,
    publish: () => run('publish', {
      title: 'Published',
      description: 'The live page now shows these changes.',
    }),
    revertToPublished: () => run('revert', {
      title: 'Reverted to published',
      description: 'The draft was discarded; earlier revisions are kept in history.',
    }),
  }
}
