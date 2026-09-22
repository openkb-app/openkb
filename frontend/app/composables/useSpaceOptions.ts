/**
 * The spaces a session can place a page in.
 *
 * Both placement surfaces — creating a page and moving one — need the same
 * thing: the list of spaces, and a way to turn whatever context named a space
 * (a space's URL slug, a space UUID) into one entry of that list. The list
 * is fetched lazily on demand rather than with the page, because it is only ever
 * needed once someone opens one of those dialogs.
 */

/** One space, as `/api/spaces` lists it. */
export interface SpaceOption {
  id: string
  internalId: number
  name: string
  slug: string
  description: string
  /** Whether the session may write here — what makes it placeable. */
  canWrite?: boolean
}

export function useSpaceOptions() {
  const spaces = ref<SpaceOption[]>([])
  const loading = ref(false)
  const failed = ref(false)

  /** Fetches the list once; repeated calls resolve from what was loaded. */
  async function load(): Promise<SpaceOption[]> {
    if (spaces.value.length || loading.value) return spaces.value
    loading.value = true
    failed.value = false
    try {
      // Only the writable ones: placing a page is `field_space` edit
      // access, so a space the session may read is a refusal, not an option.
      const listed = await $fetch<SpaceOption[]>('/api/spaces')
      spaces.value = listed.filter(space => space.canWrite === true)
    }
    catch (err) {
      console.error('[spaces] listing failed:', err)
      failed.value = true
    }
    finally {
      loading.value = false
    }
    return spaces.value
  }

  /** The space a context names, by UUID or by slug. */
  function find(space: string | null | undefined): SpaceOption | null {
    if (!space) return null
    return spaces.value.find(s => s.id === space || s.slug === space) ?? null
  }

  return { spaces, loading, failed, load, find }
}
