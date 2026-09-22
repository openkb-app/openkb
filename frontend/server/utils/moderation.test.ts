import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  commitPublishedContent,
  fetchModerationStatus,
  publishWorkingCopy,
  publishedContent,
} from './moderation'
import type { FieldSpec } from './entity-fields'

/**
 * Pins the wire shape of the two document-level moderation writes (OKB-84).
 *
 * Both ride the one commit route, and which of its two branches they land in
 * is decided entirely by whether the payload names `moderation_state`. That is
 * the whole contract: a publish that forgot the state would write a draft, and
 * a revert that included one would publish the content it was told to discard.
 */

function stubFetch(responses: Record<string, { status?: number, body?: unknown }> = {}) {
  const calls: Array<{ url: string, init: RequestInit }> = []
  const impl = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, init })
    const match = Object.entries(responses).find(([path]) => url.includes(path))
    const { status = 200, body = {} } = match?.[1] ?? {}
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response
  })
  vi.stubGlobal('fetch', impl)
  return calls
}

const AUTH = { Cookie: 'SESS=abc' }
const CHANGED = { data: { attributes: { changed: '2026-07-26T10:00:00+00:00' } } }

beforeEach(() => {
  vi.stubGlobal('useRuntimeConfig', () => ({ drupalBaseUrl: 'http://drupal.test/' }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchModerationStatus', () => {
  it('reads the status route as plain JSON under the caller carrier', async () => {
    const calls = stubFetch({
      '/openkb/node/7/moderation': { body: { nid: 7, moderated: true, state: 'draft' } },
    })
    const status = await fetchModerationStatus(AUTH, 7)
    expect(status.state).toBe('draft')
    const call = calls.find(c => c.url.includes('/moderation'))!
    const headers = call.init.headers as Record<string, string>
    expect(headers.Accept).toBe('application/json')
    expect(headers.Cookie).toBe('SESS=abc')
  })
})

describe('publishWorkingCopy', () => {
  it('posts the state and nothing else — the working copy is what goes live', async () => {
    const calls = stubFetch({ '/openkb/node/7/commit': { body: CHANGED } })
    const changed = await publishWorkingCopy(AUTH, 7)

    const commit = calls.find(c => c.url.includes('/openkb/node/7/commit'))!
    expect(commit.init.method).toBe('POST')
    const payload = JSON.parse(String(commit.init.body)) as {
      attributes: Record<string, unknown>
      relationships?: unknown
    }
    expect(payload.attributes.moderation_state).toBe('published')
    // No body: sending one would publish the sender's idea of the content
    // rather than the revision the editor has been checkpointing.
    expect(payload.attributes.field_kb_body).toBeUndefined()
    expect(payload.relationships).toBeUndefined()
    expect(changed).toBe(Math.floor(Date.parse('2026-07-26T10:00:00+00:00') / 1000))
  })
})

describe('publishedContent', () => {
  const SPECS: FieldSpec[] = [
    { key: 'summary', name: 'field_summary', label: 'Summary', type: 'string' } as FieldSpec,
  ]

  const LIVE_CHANGED = 1785000000
  const DRAFT_CHANGED = 1785003600

  /** A `kb_page` CE page, as the full display projects one. */
  function cePage(props: Record<string, unknown>, tasks: string[]) {
    return {
      body: {
        content: {
          element: 'node-kb-page',
          props: { uuid: 'uuid-1', nid: 7, path: '/wiki/page', ...props },
        },
        local_tasks: { primary: tasks.map(label => ({ label })) },
      },
    }
  }

  /** The two reads: the live revision, and the forward draft above it. */
  function stubCeReads() {
    return stubFetch({
      // Matched before the canonical read — its URL contains that one.
      '/ce-api/node/7/latest': cePage(
        { title: 'Draft title', body: 'draft body', changed: DRAFT_CHANGED, summary: 'draft summary' },
        ['Edit'],
      ),
      '/ce-api/node/7': cePage(
        { title: 'Live title', body: 'live body', changed: LIVE_CHANGED, summary: 'live summary' },
        ['Edit', 'Latest version'],
      ),
    })
  }

  it('reads the live revision, not the working copy', async () => {
    const calls = stubCeReads()
    const content = await publishedContent(AUTH, 7, { fetchSpecs: async () => SPECS })

    // The content is the live revision's, or the revert would restore the
    // draft it is discarding.
    expect(content.body).toBe('live body')
    // The working copy is read too, and only for its `changed`: it is the
    // revision this write lands on, and the token that makes it conditional.
    expect(calls.some(c => c.url.includes('/ce-api/node/7/latest'))).toBe(true)
    expect(content.basedOnChanged).toBe(DRAFT_CHANGED)
  })

  it('writes every exposed field, not a diff — the point is equality with published', async () => {
    stubCeReads()
    const content = await publishedContent(AUTH, 7, { fetchSpecs: async () => SPECS })

    expect(content.payload.attributes).toMatchObject({
      title: 'Live title',
      field_summary: 'live summary',
    })
  })

  it('asks for no working copy where the page carries no draft to read', async () => {
    const calls = stubFetch({
      '/ce-api/node/7': cePage(
        { title: 'Live title', body: 'live body', changed: LIVE_CHANGED, summary: 'live summary' },
        ['Edit'],
      ),
    })
    const content = await publishedContent(AUTH, 7, { fetchSpecs: async () => SPECS })

    expect(calls.some(c => c.url.includes('/latest'))).toBe(false)
    expect(content.basedOnChanged).toBe(LIVE_CHANGED)
  })

  it('falls back to a body-only revert when the field contract is unreachable', async () => {
    stubCeReads()
    const content = await publishedContent(AUTH, 7, { fetchSpecs: async () => null })

    expect(content.body).toBe('live body')
    expect(content.payload).toEqual({})
    expect(content.values).toEqual({})
  })
})

describe('commitPublishedContent', () => {
  it('names the draft state, so a standing publish ask goes with the draft', async () => {
    const calls = stubFetch({ '/openkb/node/7/commit': { body: CHANGED } })
    await commitPublishedContent(AUTH, 7, {
      body: 'live body',
      titleHeading: '# Live title {#b-t}\n\n',
      blockMeta: '{}',
      values: {},
      payload: { attributes: { title: 'Live title' } },
      basedOnChanged: 1700,
    })

    const commit = calls.find(c => c.url.includes('/openkb/node/7/commit'))!
    const payload = JSON.parse(String(commit.init.body)) as { attributes: Record<string, unknown> }
    expect(payload.attributes.moderation_state).toBe('draft')
    // The published body, title heading and all — a revert restores the bytes.
    expect(payload.attributes.field_kb_body)
      .toEqual({ value: '# Live title {#b-t}\n\nlive body' })
    expect(payload.attributes.title).toBe('Live title')
    expect(payload.attributes.revision_log).toBe('OpenKB revert to published')
    // The sidecar is keyed by the body's block ids, so it rides along or the
    // reverted page describes blocks it no longer has.
    expect(payload.attributes.field_block_meta).toBe('{}')
    // The revision it was assembled against: Drupal refuses the revert 409 if
    // somebody landed a write in between (OKB-167).
    expect((JSON.parse(String(commit.init.body)) as { based_on_changed?: number }).based_on_changed).toBe(1700)
  })
})
