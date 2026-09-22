import type { LiveStatus } from '~/composables/useLiveCollab'
import type { CommitStatus } from '~/composables/useDrupalCommitState'
import type { PublishBlocker } from '~/composables/useModerationStatus'
import type { ReviewStep } from '#shared/page-blocks'

/** The single edit-mode state badge — one plain view of where the work stands. */
export interface SyncChipView {
  label: string
  color: 'error' | 'warning' | 'info' | 'success'
  icon: string
  spin: boolean
}

/**
 * The one state chip the edit navbar shows.
 *
 * A broken live session (not signed in, no access, offline, still connecting)
 * wins: nothing else is true until the socket is. Otherwise the chip reflects
 * the commit lane — Saving…, Unsaved changes, a failed save — and falls back to
 * Synced (with the last-saved time when there is one) when the doc is settled.
 * This is the only status indicator in edit mode; the moderation badges live on
 * the read page.
 */
export function syncChipView(
  status: LiveStatus | undefined,
  savedAgo: string | undefined,
  commitStatus?: CommitStatus,
  commitError?: string,
): SyncChipView {
  if (status === 'auth-error') return { label: 'Not signed in', color: 'error', icon: 'i-lucide-lock', spin: false }
  if (status === 'no-access') return { label: 'No edit access', color: 'error', icon: 'i-lucide-lock', spin: false }
  if (status === 'offline') return { label: 'Offline', color: 'warning', icon: 'i-lucide-wifi-off', spin: false }
  if (status === 'connecting') return { label: 'Connecting…', color: 'info', icon: 'i-lucide-loader-circle', spin: true }
  if (commitStatus === 'saving') return { label: 'Saving…', color: 'info', icon: 'i-lucide-loader-circle', spin: true }
  if (commitStatus === 'dirty') return { label: 'Unsaved changes', color: 'warning', icon: 'i-lucide-cloud-alert', spin: false }
  if (commitStatus === 'error') return { label: commitError ?? 'Save failed', color: 'error', icon: 'i-lucide-cloud-alert', spin: false }
  return { label: savedAgo ? `Synced · ${savedAgo}` : 'Synced', color: 'success', icon: 'i-lucide-cloud-check', spin: false }
}

/**
 * The review queue the DRAWER lists: the sidecar's blocks with the last
 * refusal's blocks folded in.
 *
 * The gate checkpoints before it refuses, so its answer can name a block the
 * sidecar had not been stamped for yet when the button was pressed. Showing it
 * is the point: it is why the editor was refused, and it is the next thing to
 * go and clear. A block the sidecar already carries keeps the sidecar's steps.
 */
export function foldAwaitingBlocks(
  sidecar: Record<string, ReviewStep[]>,
  blockers: PublishBlocker[],
): Record<string, ReviewStep[]> {
  const merged: Record<string, ReviewStep[]> = { ...sidecar }
  for (const blocker of blockers) {
    if (!merged[blocker.item]) merged[blocker.item] = blocker.steps
  }
  return merged
}
