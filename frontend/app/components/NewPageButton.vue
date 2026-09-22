<script setup lang="ts">
import { addChild, nestTarget, type NestTarget } from '#shared/utils/kb-outline'
import { toFormModel, type FrontmatterSchema } from '~/editor/frontmatter-model'

/**
 * The "New page" CTA and its create dialog — the in-app creation surface.
 *
 * Creation inherits the space it is invoked from (OKB-63): a CTA that knows a
 * space passes it and shows it as fixed context, and a CTA with no space in
 * context — the home hero, or the sidebar on a page that names no space — asks
 * which space to create in, defaulting to the first one the session can see.
 * Either way the space is context around the act, never a field of the
 * document.
 *
 * A new page can be filed under the page it was created from. The tree lives on
 * the space, so placing is a space write and creating is a node write — two
 * requests, in that order, because the field constraint only accepts a page
 * that already exists in the space. The option is offered where all three parts
 * of it are true: a page is in context, it belongs to the space being created
 * in, and the session may restructure that space — the same signal the drag
 * handle answers to.
 *
 * The author types a title and picks the document type. The server creates the
 * page and pathauto mints its `<space-slug>/<title>` alias, seeds a
 * `# <title>` body and lands it as a draft; this component then navigates to
 * the new page in edit mode, so creating and writing are one continuous move
 * instead of a form submission followed by a hunt for the Edit button.
 */
const props = defineProps<{
  /** The space to create in — a space UUID or its URL slug. */
  space?: string | null
  label?: string
  size?: 'xs' | 'sm' | 'md'
  color?: 'primary' | 'neutral'
  variant?: 'solid' | 'outline' | 'soft' | 'ghost'
}>()

const open = ref(false)

// This button is rendered inside the collapsed sidebar rail, which stays
// expanded — and so mounted — while the modal is open.
useRailHold(open)

const title = ref('')
const type = ref<string | undefined>()
const chosenSpace = ref<string | undefined>()
const asChild = ref(false)
const submitting = ref(false)
const error = ref<string | null>(null)
const titleError = ref<string | null>(null)

const route = useRoute()
const { trees } = useKbOutline()
const { spaces, loading, failed, load, find } = useSpaceOptions()

// The document types, from the same exposure contract the frontmatter form
// renders from — read on open, so a page that never creates one pays nothing.
// Its own key: a fetch that has not run yet would otherwise hand the
// frontmatter form an empty schema under the shared one.
const { data: schema, execute: loadSchema } = useFetch<FrontmatterSchema>('/api/openkb/schema', {
  key: 'openkb-new-page-schema',
  immediate: false,
  default: (): FrontmatterSchema => ({}),
})
const typeOptions = computed(() => toFormModel(schema.value).find(field => field.key === 'type')?.options ?? [])

/** The space this CTA was invoked from, once the listing can name it. */
const contextSpace = computed(() => find(props.space))
/** Whether the author has to choose (no context space to inherit). */
const mustChoose = computed(() => !props.space)
const targetSpace = computed(() => (mustChoose.value ? chosenSpace.value : props.space) ?? '')
const canSubmit = computed(() => !!title.value.trim() && !!targetSpace.value && !submitting.value)

/** The page the new one can be filed under, or null where none can be. */
const parentPage = computed(() => nestTarget(trees.value, route.path, find(targetSpace.value)?.id))

watch(open, async (isOpen) => {
  if (!isOpen) return
  title.value = ''
  asChild.value = false
  error.value = null
  titleError.value = null
  const [list] = await Promise.all([load(), loadSchema()])
  // No context to inherit: start on the first space rather than an empty
  // picker, so the common case is one field and one click.
  if (mustChoose.value) chosenSpace.value = chosenSpace.value ?? list[0]?.id
  // An article is what most creations are; the field's own first value stands
  // in where the schema does not offer that one.
  type.value = typeOptions.value.find(option => option.value === 'article')?.value
    ?? typeOptions.value[0]?.value
})

async function create() {
  if (!canSubmit.value) return
  submitting.value = true
  error.value = null
  titleError.value = null
  try {
    const page = await $fetch<{ path: string, uuid: string }>('/api/kb', {
      method: 'POST',
      body: { title: title.value.trim(), space: targetSpace.value, type: type.value },
    })
    if (asChild.value && parentPage.value) await placeUnder(parentPage.value, page.uuid)
    open.value = false
    // ?edit is the in-place editor the read page opens once hydrated — the
    // same deep link /node/<nid>/edit redirects to.
    await navigateTo({ path: page.path, query: { edit: '' } })
    // The listings render from the `/api/kb` and space payloads, fetched before
    // this page existed — re-fetch so the new draft appears in its space instead
    // of after the next full reload.
    await refreshNuxtData()
  }
  catch (e: unknown) {
    describeFailure(e)
  }
  finally {
    submitting.value = false
  }
}

/**
 * Files the new page under the page it was created from.
 *
 * A refusal leaves the page where the outline sweep puts it — last at the top
 * level of its space — so a tree write that fails costs the nesting, never the
 * page.
 */
async function placeUnder(target: NestTarget, id: string) {
  try {
    await $fetch(`/api/spaces/${target.slug}/outline`, {
      method: 'PATCH',
      body: {
        outline: addChild(target.outline, target.parentId, id),
        expect: target.stored,
      },
    })
  }
  catch (e: unknown) {
    console.error('[kb-outline] placing the new page failed:', e)
  }
}

/**
 * Turns a rejection into what the author can act on.
 *
 * A 422 carries Drupal's own per-field violations (upstream.ts keeps them on
 * `data.violations`); the only field this dialog owns is the title, so a
 * violation pointing at the title or its derived slug is shown on the input and
 * everything else stays a dialog-level message rather than a mystery.
 */
function describeFailure(e: unknown) {
  type Violation = { detail?: string, source?: { pointer?: string } }
  const err = e as {
    statusCode?: number
    // `data` is the error response body, whose own `data` holds what the server
    // put on createError — hence the double hop.
    data?: { data?: { violations?: Violation[] }, violations?: Violation[] }
  }
  const status = err.statusCode
  const violations = err.data?.data?.violations ?? err.data?.violations ?? []
  if (status === 422 && violations.length) {
    const onTitle = violations.find(v =>
      /title|path/.test(v.source?.pointer ?? ''),
    )
    if (onTitle) {
      titleError.value = onTitle.detail ?? 'This title cannot be used.'
      return
    }
    error.value = violations.map(v => v.detail).filter(Boolean).join(' ')
    return
  }
  error.value = status === 401
    ? 'Your session has expired — log in again to create pages.'
    : status === 403
      ? 'You are not allowed to create pages in this space.'
      : status === 503
        ? 'OpenKnowledgebase is temporarily unavailable — the page was not created.'
        : 'Creating the page failed. Please try again.'
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="New page"
    :description="contextSpace ? `A new draft in ${contextSpace.name}.` : 'A new draft in one of your spaces.'"
  >
    <UButton
      :color="props.color ?? 'primary'"
      :variant="props.variant ?? 'solid'"
      :size="props.size ?? 'sm'"
      icon="i-lucide-plus"
      data-testid="new-page-cta"
    >
      {{ props.label ?? 'New page' }}
    </UButton>

    <template #body>
      <form data-testid="new-page-form" class="flex flex-col gap-4" @submit.prevent="create">
        <UFormField label="Title" :error="titleError ?? undefined" required>
          <UInput
            v-model="title"
            autofocus
            placeholder="What is this page about?"
            size="md"
            class="w-full"
            data-testid="new-page-title"
          />
        </UFormField>

        <UFormField v-if="typeOptions.length" label="Type">
          <USelect
            v-model="type"
            :items="typeOptions"
            value-key="value"
            size="md"
            class="w-full"
            data-testid="new-page-type"
          />
        </UFormField>

        <UFormField
          label="Space"
          :help="mustChoose ? undefined : 'Pages inherit the space they are created in. Move them later from the page menu.'"
        >
          <SpacePicker
            v-if="mustChoose"
            v-model="chosenSpace"
            :spaces="spaces"
            :disabled="loading || submitting"
          />
          <div
            v-else
            class="flex items-center gap-2 text-[13.5px] font-medium text-highlighted"
            data-testid="new-page-space"
          >
            <UIcon name="i-lucide-folder" class="size-4 text-muted" />
            {{ contextSpace?.name ?? props.space }}
          </div>
        </UFormField>

        <UCheckbox
          v-if="parentPage"
          v-model="asChild"
          data-testid="new-page-child"
          label="Child of current page"
        />

        <UAlert
          v-if="failed && mustChoose"
          color="warning"
          variant="soft"
          icon="i-lucide-alert-circle"
          description="The list of spaces could not be loaded."
        />
        <UAlert
          v-if="error"
          data-testid="new-page-error"
          color="error"
          variant="soft"
          icon="i-lucide-alert-circle"
          :description="error"
        />
      </form>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" :disabled="submitting" @click="open = false">
          Cancel
        </UButton>
        <UButton
          color="primary"
          icon="i-lucide-plus"
          :loading="submitting"
          :disabled="!canSubmit"
          data-testid="new-page-submit"
          @click="create"
        >
          Create page
        </UButton>
      </div>
    </template>
  </UModal>
</template>
