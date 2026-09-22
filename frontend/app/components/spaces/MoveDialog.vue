<script setup lang="ts">
/**
 * "Move to space…" — the deliberate placement action (OKB-98, folded into
 * OKB-96).
 *
 * Moving is an action rather than a field edit because a space is context: it is
 * not in the `.md` frontmatter and not in the editor's Details form, so the only
 * way to relocate a page is to say so. The write reaches both the published
 * revision and any forward draft (`POST /api/node/<nid>/space`), so every
 * listing regroups at once and publishing a pending draft cannot move the
 * page back.
 */
const props = defineProps<{
  nid: number
  /** The space the page is in now, if the caller knows it. */
  current?: { id: string, name: string } | null
}>()

const emit = defineEmits<{ moved: [{ id: string, name: string }] }>()

const open = defineModel<boolean>('open', { default: false })

const target = ref<string | undefined>()
const submitting = ref(false)
const error = ref<string | null>(null)

const { spaces, loading, failed, load } = useSpaceOptions()
const toast = useToast()

watch(open, async (isOpen) => {
  if (!isOpen) return
  target.value = undefined
  error.value = null
  await load()
})

async function move() {
  if (!target.value || submitting.value) return
  submitting.value = true
  error.value = null
  try {
    const result = await $fetch<{ space: { id: string, name: string } }>(
      `/api/node/${props.nid}/space`,
      { method: 'POST', body: { space: target.value } },
    )
    open.value = false
    emit('moved', result.space)
    toast.add({
      title: `Moved to ${result.space.name}`,
      icon: 'i-lucide-folder-input',
      color: 'success',
    })
  }
  catch (e: unknown) {
    const status = (e as { statusCode?: number })?.statusCode
    error.value = status === 401
      ? 'Your session has expired — log in again to move this page.'
      : status === 403
        ? 'You are not allowed to move this page.'
        : status === 404
          ? 'That space no longer exists.'
          : status === 503
            ? 'OpenKnowledgebase is temporarily unavailable — the page was not moved.'
            : 'Moving the page failed. Please try again.'
  }
  finally {
    submitting.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="Move to space"
    :description="current?.name
      ? `This page is in ${current.name}. Pick where it should live instead.`
      : 'Pick the space this page should live in.'"
  >
    <template #body>
      <form data-testid="move-space-form" class="flex flex-col gap-4" @submit.prevent="move">
        <UFormField
          label="Space"
          help="The page keeps its URL, its history and its content — only where it is listed changes."
        >
          <SpacePicker
            v-model="target"
            :spaces="spaces"
            :exclude="current?.id ?? null"
            :disabled="loading || submitting"
            placeholder="Move to…"
          />
        </UFormField>

        <UAlert
          v-if="failed"
          color="warning"
          variant="soft"
          icon="i-lucide-alert-circle"
          description="The list of spaces could not be loaded."
        />
        <UAlert
          v-if="error"
          data-testid="move-space-error"
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
          icon="i-lucide-folder-input"
          :loading="submitting"
          :disabled="!target || submitting"
          data-testid="move-space-submit"
          @click="move"
        >
          Move page
        </UButton>
      </div>
    </template>
  </UModal>
</template>
