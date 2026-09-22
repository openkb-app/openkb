import type { JSONContent } from '@tiptap/core'
import { parseMarkdownToJson } from '~/comark/markdown-engine'
import { useKbPages } from '~/composables/useOkbChromeData'
import { blockIdOf } from '#shared/page-blocks'

/**
 * The offers of the document-link picker.
 *
 * Rows come from the knowledge-base search (`/api/kb/search`), already filtered
 * to the spaces the caller may read, so an unreadable page is never offered.
 * `Handbook` asks for pages, `Handbook#roll` for one block of the best-matching
 * page, matched and labelled by each block's opening words. Block ids are
 * parsed from `/api/node/<nid>` with the editor's own engine, so they are the
 * ids the read page renders. Names come from the page list the chrome holds
 * (`useKbPages`), not from the hit, whose title the index stores tokenized.
 */

/** One row of the picker. `block` null means the row links the whole page. */
export interface DocLinkItem {
  label: string
  description: string
  icon: string
  nid: number
  path: string
  block: string | null
  /** The block's version, for a citation to be made against. Pages carry none. */
  v?: string | null
}

interface SearchHit { id: string, title: string, path: string }

/** One page as the picker reads it — its words, and its blocks' versions. */
interface Page { title: string, body: string, versions: Record<string, string> }

/** How much of a block's own text a row is labelled with. */
const LABEL_LIMIT = 60

const DEBOUNCE_MS = 120

/** The search item id is `entity:node/<nid>:<langcode>`. */
function nidOf(hit: SearchHit): number | null {
  const nid = Number(hit.id.match(/^entity:node\/(\d+)/)?.[1])
  return Number.isInteger(nid) && nid > 0 ? nid : null
}

function textOf(node: JSONContent): string {
  if (typeof node.text === 'string') return node.text
  return (node.content ?? []).map(textOf).join('')
}

function shorten(text: string): string {
  const words = text.replace(/\s+/g, ' ').trim()
  return words.length > LABEL_LIMIT ? `${words.slice(0, LABEL_LIMIT).trimEnd()}…` : words
}

/**
 * The addressable blocks of one page, in document order.
 *
 * A block with no text of its own (a bare image) is offered under its id.
 */
export function docBlocks(markdown: string): Array<{ id: string, label: string }> {
  const doc = parseMarkdownToJson(markdown)
  const blocks: Array<{ id: string, label: string }> = []
  for (const node of doc.content ?? []) {
    const id = blockIdOf(node)
    if (!id) continue
    blocks.push({ id, label: shorten(textOf(node)) || id })
  }
  return blocks
}

export function useDocLinkSearch() {
  const docItems = ref<DocLinkItem[]>([])
  const { pages } = useKbPages()
  const titleByPath = computed(() =>
    Object.fromEntries(pages.value.map(item => [item.path, item.title])))

  let abort: AbortController | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  // Cached per nid: the block rows re-read it as the query is refined.
  const fetched = new Map<number, Promise<Page>>()

  function fetchPage(nid: number, signal?: AbortSignal): Promise<Page> {
    let pending = fetched.get(nid)
    if (!pending) {
      pending = $fetch<Partial<Page>>(`/api/node/${nid}`, {
        query: { version: 'default' },
        signal,
      }).then(found => ({
        title: found.title ?? '',
        body: found.body ?? '',
        versions: found.versions ?? {},
      })).catch(() => {
        fetched.delete(nid)
        return { title: '', body: '', versions: {} }
      })
      fetched.set(nid, pending)
    }
    return pending
  }

  /** The title to store for one pick. */
  async function docLabel(item: DocLinkItem): Promise<string> {
    if (item.block) return item.label
    // Only a page the chrome's list has not seen yet needs a read.
    const known = titleByPath.value[item.path]
    if (known) return known
    return (await fetchPage(item.nid)).title || item.label
  }

  async function searchPages(query: string, signal: AbortSignal): Promise<Array<SearchHit & { nid: number }>> {
    const answer = await $fetch<{ hits?: SearchHit[] }>('/api/kb/search', {
      query: { q: query, titlePrefix: '1' },
      signal,
    })
    return (answer.hits ?? [])
      .map(hit => ({ ...hit, nid: nidOf(hit) }))
      .filter((hit): hit is SearchHit & { nid: number } => hit.nid !== null && hit.path !== '')
  }

  /** Runs the search for one announced query, debounced. */
  function searchDocs(raw: string): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(async () => {
      abort?.abort()
      abort = new AbortController()
      const signal = abort.signal
      const hash = raw.indexOf('#')
      const pageQuery = (hash === -1 ? raw : raw.slice(0, hash)).trim()
      const blockQuery = hash === -1 ? null : raw.slice(hash + 1).trim().toLowerCase()
      try {
        const hits = await searchPages(pageQuery, signal)
        if (signal.aborted) return
        if (blockQuery === null) {
          docItems.value = hits.map(hit => ({
            label: titleByPath.value[hit.path] ?? hit.title,
            description: hit.path,
            icon: 'i-lucide-file-text',
            nid: hit.nid,
            path: hit.path,
            block: null,
          }))
          return
        }
        const page = hits[0]
        if (!page) { docItems.value = []; return }
        const { body, versions } = await fetchPage(page.nid, signal)
        if (signal.aborted) return
        docItems.value = docBlocks(body)
          .filter(block => block.label.toLowerCase().includes(blockQuery))
          .map(block => ({
            label: block.label,
            description: titleByPath.value[page.path] ?? page.title,
            icon: 'i-lucide-pilcrow',
            nid: page.nid,
            path: page.path,
            block: block.id,
            // What a citation of this block is made against; the server derives
            // it off the same canonical body a read of the page serves.
            v: versions[block.id] ?? null,
          }))
      }
      catch { /* aborted or network */ }
    }, DEBOUNCE_MS)
  }

  return { docItems, searchDocs, docLabel }
}
