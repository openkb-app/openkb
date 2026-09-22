import { computed, type ComputedRef } from 'vue'
import type { AllowedHtml } from '#shared/utils/comark-tree'

/** What `GET /openkb/schema` carries beyond the frontmatter properties. */
interface BodyContract {
  body?: { allowedHtml?: AllowedHtml }
}

/**
 * The list for the surfaces that parse in the browser — a chat answer, a search
 * summary. The read page needs none of it: its tree is filtered on the server.
 * One keyed fetch serves them all.
 */
export function useAllowedHtml(): ComputedRef<AllowedHtml | undefined> {
  const { data } = useFetch<BodyContract>('/api/openkb/schema', {
    key: 'comark-allowed-html',
    default: () => ({}),
  })
  return computed(() => data.value?.body?.allowedHtml)
}
