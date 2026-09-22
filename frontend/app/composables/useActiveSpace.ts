import type { KbSpaceSummary } from '#shared/utils/kb-spaces'

/**
 * The space the reader is in, as the route names it.
 *
 * On a read page it is that page's space, read off the same listing the
 * page trees are built from — a page's own space, not whatever its first
 * path segment reads like. Otherwise a path that is a space's slug names it:
 * that is the space landing. Everywhere else — home, search — no single space
 * is in context, and both readers of this say so rather than pretending one is.
 *
 * The sidebar's switcher and the chat's retrieval scope have to agree on which
 * space that is, so they ask here.
 */
export function useActiveSpace() {
  const route = useRoute()
  const { spaces } = useSpaces()
  const { pages } = useKbPages()

  const slug = computed<string | null>(() => {
    const pageSpace = pages.value.find(a => a.path === route.path)?.space
    const onPage = spaces.value.find(s => s.id === pageSpace?.id)?.slug
    if (onPage) return onPage
    const first = route.path.split('/')[1] ?? ''
    return spaces.value.find(s => s.slug === first)?.slug ?? null
  })

  const space = computed<KbSpaceSummary | null>(
    () => spaces.value.find(s => s.slug === slug.value) ?? null,
  )

  return { slug, space }
}
