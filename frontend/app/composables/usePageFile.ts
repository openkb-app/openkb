import type { Ref } from 'vue'
import type { ResolvedFile } from '#shared/utils/files'

/** How often, and how many times, an unresolved file is asked for again. */
const RETRY_MS = 3_000
const RETRIES = 5

/**
 * Page files (ADR 0020) resolved for the current reader, on the read page, in
 * the editor and in chat.
 *
 * A peer's fresh upload is its uploader's alone until the next checkpoint
 * references it, a few seconds later, so an unresolved file is asked for again
 * a few times before it counts as unavailable.
 */
export function useResolvedPageFiles(uuids: Ref<string[]>) {
  const resolved = ref<Record<string, ResolvedFile>>({})
  const settled = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null
  let generation = 0

  async function load(run: number, attempt: number): Promise<void> {
    const missing = uuids.value.filter(uuid => !resolved.value[uuid]).slice(0, 50)
    if (missing.length > 0) {
      try {
        const { items } = await $fetch<{ items: Record<string, ResolvedFile> }>('/api/files/resolve', { query: { uuids: missing.join(',') } })
        if (run !== generation) return
        resolved.value = { ...resolved.value, ...items }
      }
      catch { /* asked again below */ }
    }
    if (run !== generation) return
    if (attempt < RETRIES && uuids.value.some(uuid => !resolved.value[uuid])) {
      timer = setTimeout(() => void load(run, attempt + 1), RETRY_MS)
      return
    }
    settled.value = true
  }

  watch(() => uuids.value.join(','), () => {
    if (timer) clearTimeout(timer)
    settled.value = false
    void load(++generation, 0)
  }, { immediate: true })

  onBeforeUnmount(() => {
    if (timer) clearTimeout(timer)
  })

  return { resolved, settled }
}

/** One page file, resolved for the current reader. */
export function usePageFile(uuid: Ref<string | null | undefined>) {
  const { resolved, settled } = useResolvedPageFiles(computed(() => uuid.value ? [uuid.value] : []))
  const file = computed(() => uuid.value ? resolved.value[uuid.value] ?? null : null)
  const state = computed<'idle' | 'loading' | 'ready' | 'unavailable'>(() => {
    if (!uuid.value) return 'idle'
    if (file.value) return 'ready'
    return settled.value ? 'unavailable' : 'loading'
  })
  return { file, state }
}
