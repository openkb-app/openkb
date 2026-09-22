import type { KbSpaceReadAccess } from '#shared/utils/kb-spaces'

/**
 * The space-policy choices, shared by the create dialog and the settings cards
 * so their labels and hints are one source, not two that can drift.
 */
export interface PolicyChoice<T> {
  value: T
  label: string
  icon: string
  hint: string
}

/** Read access — who may read a space. Members only is the default for a new one. */
export const READ_ACCESS_OPTIONS: PolicyChoice<KbSpaceReadAccess>[] = [
  {
    value: 'members_only',
    label: 'Members only',
    icon: 'i-lucide-lock',
    hint: 'Only the roster — managers, members and viewers — can find and read this space.',
  },
  {
    value: 'all_users',
    label: 'All users',
    icon: 'i-lucide-building',
    hint: 'Everyone signed in can read this space. Managers and members still write.',
  },
]

/** Editing workflow — whether publishing waits for a review. On is the default. */
export const MODERATION_OPTIONS: PolicyChoice<boolean>[] = [
  {
    value: true,
    label: 'Review before publishing',
    icon: 'i-lucide-file-clock',
    hint: 'Publishing waits until a second pair of eyes has signed the changed blocks off.',
  },
  {
    value: false,
    label: 'Publish without review',
    icon: 'i-lucide-zap',
    hint: 'Anyone on the roster publishes, whenever they are ready. Saving is a draft either way.',
  },
]
