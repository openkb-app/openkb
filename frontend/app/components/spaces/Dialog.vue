<script setup lang="ts">
/**
 * One form for creating a space and for editing an existing one's settings.
 * Editing leaves the name out — a space's name is its URL, and renaming is the
 * Drupal admin form — and carries the roster, which only exists once the space
 * does.
 */
import { computed, nextTick, ref, useId, useTemplateRef, watch } from 'vue'
import type { KbSpaceDetail, KbSpaceReadAccess } from '#shared/utils/kb-spaces'
import { READ_ACCESS_OPTIONS, MODERATION_FLAG, AGENT_REVIEW_FLAG } from '~/utils/space-policy'

/** The space being edited; absent is the create mode. */
const props = defineProps<{ space?: KbSpaceDetail | null }>()
const emit = defineEmits<{ updated: [KbSpaceDetail] }>()

const open = defineModel<boolean>('open', { default: false })

const editing = computed(() => !!props.space)
// The footer's Save sits outside the form; it submits by id.
const formId = useId()
// Each mode keeps its own test-id namespace, so a surface asserting on one
// never matches the other — nor the overview's own description behind it.
const idFor = (name: string) => `${editing.value ? 'space-settings' : 'new-space'}-${name}`

const toast = useToast()

const nameInput = useTemplateRef<{ inputRef?: HTMLInputElement | null }>('nameInput')
const name = ref('')
const description = ref('')
const readAccess = ref<KbSpaceReadAccess>('members_only')
const moderation = ref(true)
const agentReview = ref(true)
const submitting = ref(false)
const error = ref<string | null>(null)
const nameError = ref<string | null>(null)
/** What the dialog opened on: an edit writes only the fields that moved off it. */
const opened = ref({ description: '', readAccess: 'members_only' as KbSpaceReadAccess, moderation: true, agentReview: true })

const readAccessOptions = computed(() => READ_ACCESS_OPTIONS.map(option => ({ ...option, testid: idFor(`read-access-${option.value}`) })))
const moderationHint = computed(() => MODERATION_FLAG.hint[moderation.value ? 'on' : 'off'])
const agentReviewHint = computed(() => AGENT_REVIEW_FLAG.hint[agentReview.value ? 'on' : 'off'])

const canSubmit = computed(() => (editing.value || !!name.value.trim()) && !submitting.value)

watch(open, (isOpen) => {
  if (!isOpen) return
  // Editing opens on the space as it stands; creating on Drupal's own
  // defaults: members-only, moderated, agent edits signed off.
  name.value = ''
  description.value = props.space?.description ?? ''
  readAccess.value = props.space?.readAccess ?? 'members_only'
  moderation.value = props.space?.moderation ?? true
  agentReview.value = props.space?.agentReview ?? true
  error.value = null
  nameError.value = null
  opened.value = {
    description: description.value.trim(),
    readAccess: readAccess.value,
    moderation: moderation.value,
    agentReview: agentReview.value,
  }
})

async function submit() {
  if (!canSubmit.value) return
  submitting.value = true
  error.value = null
  nameError.value = null
  try {
    if (props.space) await save(props.space)
    else await create()
  }
  catch (e: unknown) {
    describeFailure(e)
    // The refusal is about the name: read it out and let the author retype.
    if (nameError.value) await nextTick(() => nameInput.value?.inputRef?.focus())
  }
  finally {
    submitting.value = false
  }
}

async function create() {
  const space = await $fetch<{ id: string, slug: string }>('/api/spaces', {
    method: 'POST',
    body: {
      name: name.value.trim(),
      description: description.value.trim() || undefined,
      readAccess: readAccess.value,
      moderation: moderation.value,
      agentReview: agentReview.value,
    },
  })
  // The space exists from here on: close on that, not on the navigation that
  // follows, so the modal is not still up over the new space's page.
  open.value = false
  // The sidebar and the home page hold their `/api/spaces` payload from
  // before this space existed — re-fetch so it appears without a reload.
  await settle('The space was created, but opening it failed. Reload to see it.', async () => {
    await navigateTo(`/${space.slug}`)
    await refreshNuxtData()
  })
}

async function save(space: KbSpaceDetail) {
  // Only what the author changed: a whole write would put the fields they left
  // alone back over another manager's edit.
  const body: Record<string, unknown> = {}
  if (description.value.trim() !== opened.value.description) body.description = description.value.trim()
  if (readAccess.value !== opened.value.readAccess) body.readAccess = readAccess.value
  if (moderation.value !== opened.value.moderation) body.moderation = moderation.value
  if (agentReview.value !== opened.value.agentReview) body.agentReview = agentReview.value
  if (Object.keys(body).length === 0) {
    open.value = false
    return
  }

  const updated = await $fetch<KbSpaceDetail>(`/api/spaces/${space.slug}`, { method: 'PATCH', body })
  open.value = false
  emit('updated', updated)
  // The description rides the space's own CE payload and the space cards.
  await settle('The settings were saved, but the page did not refresh. Reload to see them.', () => refreshNuxtData())
}

/**
 * Runs what follows the write, which the dialog is already closed for: an
 * alert behind a closed modal is never seen, so a failure here goes to a
 * toast, and it says the write itself held.
 */
async function settle(failed: string, run: () => Promise<unknown>) {
  try {
    await run()
  }
  catch {
    toast.add({ title: failed, icon: 'i-lucide-alert-circle', color: 'error' })
  }
}

/**
 * Turns a rejection into what the author can act on. A 422 carries Drupal's own
 * per-field violations; one pointing at `label` renders under the name input,
 * with Drupal's field prefix dropped because the input is already labelled.
 */
function describeFailure(e: unknown) {
  type Violation = { detail?: string, source?: { pointer?: string } }
  const err = e as {
    statusCode?: number
    data?: { data?: { violations?: Violation[] }, violations?: Violation[] }
  }
  const status = err.statusCode
  const violations = err.data?.data?.violations ?? err.data?.violations ?? []
  if (status === 422 && violations.length) {
    const onName = violations.find(v => /\/label$/.test(v.source?.pointer ?? ''))
    if (onName) {
      nameError.value = onName.detail?.replace(/^label:\s*/, '') ?? 'This name cannot be used.'
      return
    }
    error.value = violations.map(v => v.detail).filter(Boolean).join(' ')
    return
  }
  const what = editing.value ? 'the settings were not saved' : 'the space was not created'
  error.value = status === 401
    ? 'Your session has expired — log in again.'
    : status === 403
      ? (editing.value ? 'You are not allowed to manage this space.' : 'You are not allowed to create spaces.')
      : status === 503
        ? `OpenKnowledgebase is temporarily unavailable — ${what}.`
        : editing.value
          ? 'Saving the settings failed. Please try again.'
          : 'Creating the space failed. Please try again.'
}
</script>

<template>
  <UModal
    v-model:open="open"
    :ui="{ content: 'sm:max-w-4xl' }"
    :title="editing ? 'Space settings' : 'New space'"
    :description="editing
      ? 'Who may read this space, how edits are published, and who is on its roster. The name is the space\'s URL and is changed in Drupal.'
      : 'A space you administer. Set who can read it and how edits are published — invite people later from its settings.'"
  >
    <template #body>
      <div class="flex flex-col gap-5">
        <form :id="formId" :data-testid="idFor('form')" class="flex flex-col gap-5" @submit.prevent="submit">
          <UFormField v-if="!editing" label="Name" :error="nameError ?? undefined" required>
            <UInput
              ref="nameInput"
              v-model="name"
              autofocus
              placeholder="e.g. Engineering"
              size="md"
              class="w-full"
              data-testid="new-space-name"
            />
            <template #error="{ error: message }">
              <span role="alert" data-testid="new-space-name-error">{{ message }}</span>
            </template>
          </UFormField>

          <UFormField label="Description" help="What is this space for? Shown on its card and in the switcher.">
            <UTextarea
              v-model="description"
              :rows="2"
              size="md"
              class="w-full"
              :ui="{ base: 'text-sm' }"
              :data-testid="idFor('description')"
            />
          </UFormField>

          <UFormField label="Read access">
            <SpacePolicyOptions
              v-model="readAccess"
              :options="readAccessOptions"
              :disabled="submitting"
              aria-label="Read access"
            />
          </UFormField>

          <!-- Two yes/no flags: each switch names its on-state, the hint
               says what the current state does. A fieldset, not a form field:
               each switch is labelled by its own label, the legend names the
               group. -->
          <fieldset class="flex min-w-0 flex-col gap-3">
            <legend class="mb-1 block text-sm font-medium text-default">
              Publishing
            </legend>
            <USwitch
              :id="idFor('moderation')"
              v-model="moderation"
              :label="MODERATION_FLAG.label"
              :description="moderationHint"
              :disabled="submitting"
              :data-testid="idFor('moderation')"
            />
            <USwitch
              :id="idFor('agent-review')"
              v-model="agentReview"
              :label="AGENT_REVIEW_FLAG.label"
              :description="agentReviewHint"
              :disabled="submitting"
              :data-testid="idFor('agent-review')"
            />
          </fieldset>
        </form>

        <!-- Its own form, outside this one: the roster saves per change, on the
             space that already exists. -->
        <SpaceMembers v-if="space" :space="space" @updated="value => emit('updated', value)" />

        <UAlert
          v-if="error"
          :data-testid="idFor('error')"
          color="error"
          variant="soft"
          icon="i-lucide-alert-circle"
          :description="error"
        />
      </div>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" :disabled="submitting" @click="open = false">
          Cancel
        </UButton>
        <UButton
          color="primary"
          :icon="editing ? 'i-lucide-check' : 'i-lucide-plus'"
          :loading="submitting"
          :disabled="!canSubmit"
          :data-testid="idFor('submit')"
          type="submit"
          :form="formId"
        >
          {{ editing ? 'Save changes' : 'Create space' }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
