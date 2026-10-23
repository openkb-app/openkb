import type { Ref } from 'vue'
import type { PageAttachment, ResolvedFile } from '#shared/utils/files'

/** How often, and how many times, an unresolved file is asked for again. */
const RETRY_MS = 3_000
const RETRIES = 5

/**
 * Files this reader resolved before, by UUID, in the browser only: an embed
 * starts from them, so the editor shows it at the read page's size before
 * its own lookup answers.
 */
const known = new Map<string, ResolvedFile>()

/** Remembers the read page's files for the editor. */
export function rememberPageFiles(files: PageAttachment[]): void {
  if (import.meta.client) files.forEach(({ id, description: _, ...file }) => known.set(id, file))
}

/** Remembers a file the read page's text embeds, unless its list gave it already. */
export function rememberEmbeddedFile(id: string, file: ResolvedFile): void {
  if (import.meta.client && !known.has(id)) known.set(id, file)
}

/**
 * Page files (ADR 0020) resolved for the current reader, on the read page, in
 * the editor and in chat.
 *
 * A peer's fresh upload is its uploader's alone until the next checkpoint
 * references it, a few seconds later, so an unresolved file is asked for again
 * a few times before it counts as unavailable.
 */
export function useResolvedPageFiles(uuids: Ref<string[]>) {
  const resolved = ref<Record<string, ResolvedFile>>(Object.fromEntries(uuids.value.flatMap(uuid => known.has(uuid) ? [[uuid, known.get(uuid)!]] : [])))
  // Answered by the lookup; a remembered file still asks, and goes if not answered.
  const confirmed = new Set<string>()
  const settled = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null
  let generation = 0

  async function load(run: number, attempt: number): Promise<void> {
    const missing = uuids.value.filter(uuid => !confirmed.has(uuid)).slice(0, 50)
    if (missing.length > 0) {
      try {
        const { items } = await $fetch<{ items: Record<string, ResolvedFile> }>('/api/files/resolve', { query: { uuids: missing.join(',') } })
        if (run !== generation) return
        const kept = Object.entries(resolved.value).filter(([uuid]) => !missing.includes(uuid) || items[uuid])
        resolved.value = { ...Object.fromEntries(kept), ...items }
        for (const [uuid, file] of Object.entries(items)) {
          confirmed.add(uuid)
          if (import.meta.client) known.set(uuid, file)
        }
      }
      catch { /* asked again below */ }
    }
    if (run !== generation) return
    if (attempt < RETRIES && uuids.value.some(uuid => !confirmed.has(uuid))) {
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
