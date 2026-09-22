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
 * (`canManage`); everyone else sees the same list, read-only.
 */
import type { KbSpaceDetail, KbSpaceMember, KbSpaceRole } from '#shared/utils/kb-spaces'

const props = defineProps<{ space: KbSpaceDetail }>()
const emit = defineEmits<{ updated: [KbSpaceDetail] }>()

interface RosterRow extends KbSpaceMember {
  role: KbSpaceRole
}

const ROLE_ITEMS = [
  { label: 'Manager', value: 'manager' as const },
  { label: 'Member', value: 'member' as const },
  { label: 'Viewer', value: 'viewer' as const },
]

const ROLE_LABELS: Record<KbSpaceRole, string> = { manager: 'Manager', member: 'Member', viewer: 'Viewer' }

// Ranks are exclusive; if a user appears on more than one field, the highest
// wins, so nobody is listed twice.
const rows = computed<RosterRow[]>(() => {
  const seen = new Set<string>()
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
    const updated = await $fetch<KbSpaceDetail>(`/api/spaces/${props.space.slug}`, {
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

function setRole(member: KbSpaceMember, role: KbSpaceRole) {
  save(rows.value.map(row => (row.id === member.id ? { ...row, role } : row)))
}

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
    class="rounded-[12px] bg-default px-[18px] pb-4 pt-4 shadow-[0_0_0_1px_var(--ui-border)]"
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
        <UIcon name="i-lucide-user" class="size-[13px] text-muted" />
        <span class="text-[13.5px] font-medium text-highlighted">{{ row.name }}</span>

        <div class="ml-auto flex items-center gap-2">
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

    <form
      v-if="space.canManage"
      data-testid="space-members-add"
      class="mt-3 flex items-center gap-2 border-t border-(--ui-border) pt-3"
      @submit.prevent="add"
    >
      <div data-testid="space-members-search" class="min-w-[220px] flex-1">
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
        data-testid="space-members-add-role"
      />

      <UButton
        type="submit"
        size="sm"
        color="neutral"
        :disabled="!picked || saving"
        data-testid="space-members-add-submit"
      >
        Add
      </UButton>
    </form>
  </section>
</template>
