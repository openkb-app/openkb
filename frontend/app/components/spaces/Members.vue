<script setup lang="ts">
/**
 * Roster management for one space, straight against the space.
 *
 * The space carries three ranked user-reference fields — `managers`
 * (manage + write), `members` (write) and `viewers` (read only) —
 * and this form maps them onto one list of people with a role each: a user sits
 * in exactly one of the three, so changing a role moves the reference rather
 * than duplicating it. Every edit sends the whole roster in one PATCH
 * (`/api/spaces/<slug>`), which is what makes the space the aggregate root;
 * concurrent managers therefore overwrite each other, last write wins.
 *
 * Controls render only for a session Drupal would let manage the space
 * (`canManage`); everyone else sees the same list, read-only. A manager who
 * may invite users (`canInvite`) also invites people by email
 * (`space-invites`). The invitee joins the roster only by accepting; until
 * then the invite is listed as pending, loaded when the form mounts and after
 * each invite; none while loading or on failure.
 *
 * Narrow containers wrap each form row, so it fits a phone.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { KB_SPACE_ROLES, type KbSpaceDetail, type KbSpaceMember, type KbSpaceRole } from '#shared/utils/kb-spaces'
import { inviteToSpaceByEmail, loadSpacePendingInvites, type KbPendingInvite } from '~/utils/space-invites'

const props = defineProps<{ space: KbSpaceDetail }>()
const emit = defineEmits<{ updated: [KbSpaceDetail] }>()

interface RosterRow extends KbSpaceMember {
  role: KbSpaceRole
}

const ROLE_LABELS: Record<KbSpaceRole, string> = { manager: 'Manager', member: 'Member', viewer: 'Viewer' }

const ROLE_ITEMS = KB_SPACE_ROLES.map(value => ({ label: ROLE_LABELS[value], value }))

// Ranks are exclusive; if a user appears on more than one field, the highest
// wins, so nobody is listed twice.
const rows = computed<RosterRow[]>(() => {
  const seen = new Set<string>()
  /** The users not listed yet, as rows of the role. */
  const rank = (users: KbSpaceMember[], role: KbSpaceRole) =>
    users.filter((user) => {
      if (seen.has(user.id)) return false
      seen.add(user.id)
      return true
    }).map(user => ({ ...user, role }))
  return [
    ...rank(props.space.managers, 'manager'),
    ...rank(props.space.members, 'member'),
    ...rank(props.space.viewers, 'viewer'),
  ]
})

const saving = ref(false)
const error = ref<string | null>(null)

/** Sends `next` as the complete roster and adopts the space the server returns. */
async function save(next: RosterRow[]) {
  if (saving.value) return
  saving.value = true
  error.value = null
  try {
    const updated = await csrfFetch<KbSpaceDetail>(`/api/spaces/${props.space.slug}`, {
      method: 'PATCH',
      body: {
        managers: next.filter(row => row.role === 'manager').map(row => row.id),
        members: next.filter(row => row.role === 'member').map(row => row.id),
        viewers: next.filter(row => row.role === 'viewer').map(row => row.id),
      },
    })
    emit('updated', updated)
  }
  catch (e: unknown) {
    const status = (e as { statusCode?: number })?.statusCode
    error.value = status === 403
      ? 'You are not allowed to manage this space.'
      : status === 503
        ? 'OpenKnowledgebase is temporarily unavailable — the roster was not changed.'
        : 'Saving the roster failed. Please try again.'
  }
  finally {
    saving.value = false
  }
}

/** Moves the member to another roster. */
function setRole(member: KbSpaceMember, role: KbSpaceRole) {
  save(rows.value.map(row => (row.id === member.id ? { ...row, role } : row)))
}

/** Takes the member off the space's roster. */
function remove(member: KbSpaceMember) {
  save(rows.value.filter(row => row.id !== member.id))
}

// --- add form -------------------------------------------------------------

interface UserOption { id: string, uid: number, name: string }

const candidates = ref<UserOption[]>([])
const searching = ref(false)
const searchTerm = ref('')
const picked = ref<UserOption | undefined>()
const newRole = ref<KbSpaceRole>('member')

let timer: ReturnType<typeof setTimeout> | null = null
let controller: AbortController | null = null

/** Fills the add-a-person options with the users matching `q` who are not on the roster yet. */
async function searchUsers(q: string) {
  if (controller) controller.abort()
  if (!q) { candidates.value = []; return }
  controller = new AbortController()
  searching.value = true
  try {
    const res = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`, {
      signal: controller.signal,
      credentials: 'same-origin',
    })
    if (!res.ok) { candidates.value = []; return }
    const data = await res.json() as { users?: UserOption[] }
    // People already on the roster are not addable twice — change their role.
    const onRoster = new Set(rows.value.map(row => row.id))
    candidates.value = (data.users ?? []).filter(user => !onRoster.has(user.id))
  }
  catch { /* aborted or network — keep the last options */ }
  finally { searching.value = false }
}

watch(searchTerm, (q) => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => searchUsers(q.trim()), 150)
})

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
  if (controller) controller.abort()
})

// --- invite form ----------------------------------------------------------

const pendingInvites = ref<KbPendingInvite[]>([])

/** Lists the pending invites; none on failure. */
async function showPendingInvites() {
  if (!props.space.canInvite) return
  try {
    pendingInvites.value = await loadSpacePendingInvites(props.space)
  }
  catch {
    pendingInvites.value = []
  }
}

onMounted(showPendingInvites)

const inviteEmail = ref('')
const inviteRole = ref<KbSpaceRole>('member')
const inviting = ref(false)
const inviteError = ref<string | null>(null)
const inviteNotice = ref<string | null>(null)

/**
 * The sentence for a refused invite: Drupal's own for a 422, without the
 * property path (`mail.0.value: `) or `Entity is not valid: ` JSON:API puts first.
 */
function inviteErrorMessage(e: unknown): string {
  const err = e as { statusCode?: number, data?: { data?: { violations?: Array<{ detail?: string }> } } }
  const detail = err?.data?.data?.violations?.[0]?.detail
  if (err?.statusCode === 422 && detail) return detail.replace(/^(?:Entity is not valid|[a-z_]+(?:\.\d+(?:\.[a-z_]+)?)?): /, '')
  if (err?.statusCode === 403) return 'You are not allowed to invite people.'
  return 'Sending the invitation failed. Please try again.'
}

/** Invites `inviteEmail` onto the roster and lists the invite as pending. */
async function invite() {
  const email = inviteEmail.value.trim()
  if (!email || inviting.value) return
  inviting.value = true
  inviteError.value = null
  inviteNotice.value = null
  try {
    await inviteToSpaceByEmail(props.space, email, inviteRole.value)
    inviteNotice.value = `Invitation sent to ${email}.`
    inviteEmail.value = ''
  }
  catch (e: unknown) {
    inviteError.value = inviteErrorMessage(e)
  }
  finally {
    inviting.value = false
  }
  await showPendingInvites()
}

/** Adds the picked user to the roster with the chosen role. */
async function add() {
  const user = picked.value
  if (!user) return
  await save([...rows.value, { ...user, role: newRole.value }])
  picked.value = undefined
  searchTerm.value = ''
  candidates.value = []
}
</script>

<template>
  <section
    data-testid="space-members"
    class="@container/members rounded-[12px] bg-default px-[18px] pb-4 pt-4 shadow-[0_0_0_1px_var(--ui-border)]"
  >
    <header class="mb-3 flex items-center gap-2">
      <UIcon name="i-lucide-users" class="size-[15px] text-muted" />
      <h2 class="text-[14px] font-semibold tracking-tight text-highlighted">
        Members
      </h2>
      <UBadge color="neutral" variant="soft" size="sm" data-testid="space-members-count">
        {{ rows.length }}
      </UBadge>
      <UIcon v-if="saving" name="i-lucide-loader-circle" class="size-[13px] animate-spin text-muted" />
    </header>

    <UAlert
      v-if="error"
      data-testid="space-members-error"
      color="error"
      variant="soft"
      icon="i-lucide-alert-circle"
      :description="error"
      class="mb-3"
    />

    <ul v-if="rows.length" class="flex flex-col divide-y divide-(--ui-border)">
      <li
        v-for="row in rows"
        :key="row.id"
        :data-testid="`space-member-${row.name}`"
        class="flex items-center gap-3 py-2"
      >
        <UIcon name="i-lucide-user" class="size-[13px] shrink-0 text-muted" />
        <span class="min-w-0 break-words text-[13.5px] font-medium text-highlighted">{{ row.name }}</span>

        <div class="ml-auto flex shrink-0 items-center gap-2">
          <USelect
            v-if="space.canManage"
            :model-value="row.role"
            :items="ROLE_ITEMS"
            value-key="value"
            size="xs"
            :disabled="saving"
            :aria-label="`Role for ${row.name}`"
            :data-testid="`space-member-role-${row.name}`"
            @update:model-value="value => setRole(row, value as KbSpaceRole)"
          />
          <UBadge v-else color="neutral" variant="subtle" size="sm">
            {{ ROLE_LABELS[row.role] }}
          </UBadge>

          <UButton
            v-if="space.canManage"
            icon="i-lucide-x"
            color="neutral"
            variant="ghost"
            size="xs"
            :disabled="saving"
            :aria-label="`Remove ${row.name}`"
            :data-testid="`space-member-remove-${row.name}`"
            @click="remove(row)"
          />
        </div>
      </li>
    </ul>

    <p v-else class="py-2 text-[13px] italic text-muted">
      No members yet.
    </p>

    <div
      v-if="pendingInvites.length"
      data-testid="space-members-pending"
      class="mt-3 border-t border-(--ui-border) pt-3"
    >
      <h3 class="text-[12.5px] font-semibold text-muted">
        Pending invitations
      </h3>
      <ul class="flex flex-col divide-y divide-(--ui-border)">
        <li
          v-for="pending in pendingInvites"
          :key="pending.id"
          :data-testid="`space-invite-pending-${pending.mail ?? pending.id}`"
          class="flex items-center gap-3 py-2"
        >
          <UIcon name="i-lucide-mail" class="size-[13px] shrink-0 text-muted" />
          <span class="min-w-0 break-all text-[13.5px] text-toned">{{ pending.mail ?? 'Invited by another manager' }}</span>
          <UBadge color="neutral" variant="subtle" size="sm" class="ml-auto shrink-0">
            {{ ROLE_LABELS[pending.role] }}
          </UBadge>
        </li>
      </ul>
    </div>

    <form
      v-if="space.canManage"
      data-testid="space-members-add"
      class="mt-3 flex flex-wrap items-center gap-2 border-t border-(--ui-border) pt-3 @md/members:flex-nowrap"
      @submit.prevent="add"
    >
      <div data-testid="space-members-search" class="w-full @md/members:w-auto @md/members:min-w-0 @md/members:flex-1">
        <UInputMenu
          v-model="picked"
          v-model:search-term="searchTerm"
          :items="candidates"
          :loading="searching"
          by="id"
          label-key="name"
          ignore-filter
          placeholder="Add a person…"
          size="sm"
          icon="i-lucide-user-plus"
          class="w-full"
        >
          <template #empty>
            <span class="text-[12px] text-muted">
              {{ searchTerm ? 'No matches.' : 'Type to search…' }}
            </span>
          </template>
        </UInputMenu>
      </div>

      <USelect
        v-model="newRole"
        :items="ROLE_ITEMS"
        value-key="value"
        size="sm"
        aria-label="Role for the person being added"
        class="min-w-0 flex-1 @md/members:w-28 @md/members:flex-none"
        data-testid="space-members-add-role"
      />

      <UButton
        type="submit"
        size="sm"
        color="neutral"
        :disabled="!picked || saving"
        class="w-16 justify-center"
        data-testid="space-members-add-submit"
      >
        Add
      </UButton>
    </form>

    <form
      v-if="space.canInvite"
      data-testid="space-members-invite"
      class="mt-3 flex flex-col gap-2 border-t border-(--ui-border) pt-3"
      @submit.prevent="invite"
    >
      <div class="flex flex-wrap items-center gap-2 @md/members:flex-nowrap">
        <UInput
          v-model="inviteEmail"
          type="email"
          required
          autocomplete="off"
          placeholder="Invite by email…"
          aria-label="Email address to invite"
          size="sm"
          icon="i-lucide-mail"
          class="w-full @md/members:w-auto @md/members:min-w-0 @md/members:flex-1"
          data-testid="space-members-invite-email"
        />

        <USelect
          v-model="inviteRole"
          :items="ROLE_ITEMS"
          value-key="value"
          size="sm"
          aria-label="Role for the person being invited"
          class="min-w-0 flex-1 @md/members:w-28 @md/members:flex-none"
          data-testid="space-members-invite-role"
        />

        <UButton
          type="submit"
          size="sm"
          color="neutral"
          :loading="inviting"
          :disabled="!inviteEmail.trim() || inviting"
          class="w-16 justify-center"
          data-testid="space-members-invite-submit"
        >
          Invite
        </UButton>
      </div>

      <p
        v-if="inviteNotice"
        role="status"
        class="break-words text-[12.5px] text-muted"
        data-testid="space-members-invite-notice"
      >
        {{ inviteNotice }}
      </p>
      <p
        v-if="inviteError"
        role="alert"
        class="break-words text-[12.5px] text-error"
        data-testid="space-members-invite-error"
      >
        {{ inviteError }}
      </p>
    </form>
  </section>
</template>
