import type { ExcerptPart } from '#shared/utils/kb-search'
import { markedParts } from '#shared/utils/kb-search'

/**
 * The titles offered under the search box while someone types.
 *
 * The lexical arm of the chunk index alone (`/api/kb/search?titlePrefix=1`):
 * a prefix costs no embedding, so it can be asked for per keystroke, where
 * the semantic search cannot. The box itself stays submit-on-Enter.
 */

/** One offered page. */
export interface TitleSuggestion {
  /** The search_api item id, `entity:node/<nid>:<langcode>`. */
  id: string
  /** The title, split into plain and matched runs. */
  parts: ExcerptPart[]
  title: string
  path: string
  space: string
  /** The page's document type, by machine name. */
  type: string
}

interface TitleHit {
  id?: string
  title?: string
  path?: string
  space?: string
  type?: string
  highlights?: string[]
}

/** Rows one offer holds; the last row of the list runs the search instead. */
const ROWS = 8

/** How long the typing has to settle before a prefix is asked for. */
const DEBOUNCE_MS = 150

/** How much has to be typed before a prefix can offer anything useful. */
export const SUGGEST_MIN_LENGTH = 2

export function useTitleSuggest(space: Ref<string>) {
  const suggestions = ref<TitleSuggestion[]>([])

  let abort: AbortController | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  /** Drops what is on screen and whatever answer is still on its way. */
  function clear(): void {
    if (timer) clearTimeout(timer)
    timer = null
    abort?.abort()
    abort = null
    suggestions.value = []
  }

  /** Offers titles for what has been typed so far. */
  function suggest(typed: string): void {
    const prefix = typed.trim()
    if (timer) clearTimeout(timer)
    if (prefix.length < SUGGEST_MIN_LENGTH) {
      clear()
      return
    }
    timer = setTimeout(async () => {
      abort?.abort()
      abort = new AbortController()
      const signal = abort.signal
      try {
        const answer = await $fetch<{ hits?: TitleHit[] }>('/api/kb/search', {
          query: { q: prefix, titlePrefix: '1', space: space.value || undefined },
          signal,
        })
        if (signal.aborted) return
        suggestions.value = (answer.hits ?? []).slice(0, ROWS).map(toSuggestion)
      }
      catch {
        // Aborted, or the read failed: the box stays usable and offers nothing.
        if (!signal.aborted) suggestions.value = []
      }
    }, DEBOUNCE_MS)
  }

  onScopeDispose(clear)

  return { suggestions, suggest, clear }
}

function toSuggestion(hit: TitleHit): TitleSuggestion {
  const title = hit.title ?? ''
  const fragment = hit.highlights?.[0]
  return {
    id: hit.id ?? '',
    title,
    parts: fragment ? markedParts(fragment) : [{ text: title, marked: false }],
    path: hit.path ?? '',
    space: hit.space ?? '',
    type: hit.type ?? '',
  }
}
