import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { H3Event } from 'h3'
import type { FieldSpec } from '../../utils/entity-fields'
import handler from './[...path].get'

/**
 * The one catch-all serves three shapes off a space-scoped path: the published
 * `.md`, the working-copy `…/draft.md`, and a plain JSON view. These tests pin
 * only what this layer decides — which revision each address dispatches to, and
 * that the draft suffix is told apart from a page slugged `draft` by the
 * surviving slash. The markdown projection itself is `kb-read`'s to pin.
 */

const fetchCePage = vi.fn()
const fetchCeWorkingCopy = vi.fn()
const fetchFrontmatterSpecs = vi.fn()

vi.mock('../../utils/drupal', () => ({
  fetchCePage: (...a: unknown[]) => fetchCePage(...a),
  findKbPageByPath: async (...a: unknown[]) => (await fetchCePage(...a))?.page ?? null,
  fetchCeWorkingCopy: (...a: unknown[]) => fetchCeWorkingCopy(...a),
  fetchFrontmatterSpecs: (...a: unknown[]) => fetchFrontmatterSpecs(...a),
}))

const liveContent = vi.fn()
vi.mock('../../utils/session-read', () => ({
  liveContent: (...a: unknown[]) => liveContent(...a),
}))

const SPECS: FieldSpec[] = [
  { key: 'type', name: 'field_type', multiple: false, reference: false },
]

/** What fetchCePage answers: the mapped page beside its raw CE props. */
function cePage(page: Record<string, unknown>, canEdit = false) {
  return { page: { id: 'n-1', ...page }, props: {}, canEdit }
}

function event(path: string): H3Event & { headers: Record<string, string> } {
  const headers: Record<string, string> = {}
  return {
    context: { params: { path } },
    node: {
      req: { headers: {} },
      res: { setHeader: (k: string, v: string) => { headers[k] = v } },
    },
    headers,
  } as unknown as H3Event & { headers: Record<string, string> }
}

describe('GET /api/kb/<space>/<slug>(.md|/draft.md)', () => {
  beforeEach(() => {
    fetchCePage.mockReset()
    fetchCeWorkingCopy.mockReset()
    fetchFrontmatterSpecs.mockReset().mockResolvedValue(SPECS)
    liveContent.mockReset().mockReturnValue(null)
  })

  it('404s when the page is missing', async () => {
    fetchCePage.mockResolvedValue(null)
    await expect(handler(event('team-wiki/missing.md'))).rejects.toMatchObject({ statusCode: 404 })
  })

  it('.md → the published body as text/markdown, path stripped of the suffix', async () => {
    // The mappers split the title heading off the stored body, so the `.md`
    // this route serves — and Copy-as-Markdown with it — never carries it.
    fetchCePage.mockResolvedValue(cePage({
      nid: 7,
      path: '/team-wiki/getting-started',
      titleHeading: '# Getting started\n\n',
      body: 'Body.',
    }))

    const ev = event('team-wiki/getting-started.md')
    const md = await handler(ev) as string

    expect(ev.headers['Content-Type']).toBe('text/markdown; charset=utf-8')
    expect(md).toContain('Body.')
    expect(md).not.toContain('# Getting started')
    expect(fetchCePage).toHaveBeenCalledWith(ev, 'team-wiki/getting-started')
    expect(fetchCeWorkingCopy).not.toHaveBeenCalled()
  })

  it('serves the body as characters — the `.md` address is read as source', async () => {
    // A person opening the raw view and a model over MCP read the same page,
    // so neither is handed the serializer's entities (ADR 0014). The
    // projection is kb-read's; what this pins is that the route serves it.
    fetchCePage.mockResolvedValue(cePage({
      nid: 7,
      path: '/team-wiki/getting-started',
      body: 'Wiki &amp; AI, 5 &lt; 6.',
    }))

    expect(await handler(event('team-wiki/getting-started.md')) as string)
      .toContain('Wiki & AI, 5 < 6.')
  })

  it('/draft.md → the working copy, marked with the revision header', async () => {
    const live = cePage({ nid: 7, path: '/team-wiki/getting-started', body: 'Published.' }, true)
    fetchCePage.mockResolvedValue(live)
    fetchCeWorkingCopy.mockResolvedValue(cePage({ nid: 7, path: '/team-wiki/getting-started', body: 'Draft.' }))

    const ev = event('team-wiki/getting-started/draft.md')
    const md = await handler(ev) as string

    expect(ev.headers['X-OpenKB-Revision']).toBe('working-copy')
    expect(md).toContain('Draft.')
    expect(fetchCeWorkingCopy).toHaveBeenCalledWith({}, 7, live)
  })

  it('/draft.md → 403 for an account that may not write the page', async () => {
    // The draft address is for the editing surfaces, so a reader is refused
    // rather than served the published body under it.
    fetchCePage.mockResolvedValue(
      cePage({ nid: 7, path: '/team-wiki/getting-started', body: 'Published.' }),
    )

    await expect(handler(event('team-wiki/getting-started/draft.md')))
      .rejects.toMatchObject({ statusCode: 403 })
    expect(fetchCeWorkingCopy).not.toHaveBeenCalled()
  })

  it('non-.md → a JSON view addressed by path, no frontmatter fetch', async () => {
    fetchCePage.mockResolvedValue(cePage({ nid: 7, path: '/team-wiki/getting-started', title: 'Getting started', body: 'text' }))
    const result = await handler(event('team-wiki/getting-started')) as Record<string, unknown>
    expect(result).toMatchObject({ path: '/team-wiki/getting-started', title: 'Getting started', body: 'text' })
    expect(fetchFrontmatterSpecs).not.toHaveBeenCalled()
  })

  it('a page slugged `draft` reads as a published .md, not a draft request', async () => {
    // `team-wiki/draft.md` strips to `team-wiki` (no slash) → published branch.
    fetchCePage.mockResolvedValue(cePage({ nid: 9, path: '/team-wiki/draft', body: 'Body.' }))
    const ev = event('team-wiki/draft.md')
    await handler(ev)
    expect(fetchCePage).toHaveBeenCalledWith(ev, 'team-wiki/draft')
    expect(fetchCeWorkingCopy).not.toHaveBeenCalled()
  })
})
