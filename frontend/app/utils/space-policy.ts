import type { KbSpaceReadAccess } from '#shared/utils/kb-spaces'

/**
 * The space-policy texts, shared by the create dialog and the settings dialog
 * so their labels and hints are one source, not two that can drift.
 */
export interface PolicyChoice<T> {
  value: T
  label: string
  icon: string
  hint: string
}

/** A yes/no policy shown as a switch: the label names the on-state. */
export interface PolicyFlag {
  label: string
  /** What the current state does — the switch shows the one that applies. */
  hint: { on: string, off: string }
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
export const MODERATION_FLAG: PolicyFlag = {
  label: 'Review before publishing',
  hint: {
    on: 'Publishing waits until a second pair of eyes has signed the changed blocks off.',
    off: 'Anyone on the roster publishes, whenever they are ready. Saving is a draft either way.',
  },
}

/**
 * Agent review — whether a block an agent wrote waits for a human sign-off.
 * On is the default, and it holds in a wiki space too.
 */
export const AGENT_REVIEW_FLAG: PolicyFlag = {
  label: 'Agent edits need a human sign-off',
  hint: {
    on: 'A block an agent wrote waits for a person to sign it off before the page can be published.',
    off: 'Agent-written blocks publish like human edits. Whatever review this space runs still applies to them.',
  },
}
