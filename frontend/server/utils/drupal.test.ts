import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { H3Event } from 'h3'
import { commitKbPageWithAuth, createKbPage, deleteKbPageWithAuth, drupalFetch, drupalFetchWithCookie, fetchCeNode, fetchCeRevision, fetchCeWorkingCopy, findKbPageByPath, patchKbPageWithAuth, probeDeleteAccess, sitePermissions, type CePageRead } from './drupal'

/**
 * Pins the auth-forwarding contract of the JSON:API bridge: the incoming
 * carrier (Bearer token or session cookie) is forwarded verbatim, exactly one
 * of them, and the CSRF-token dance stays a cookie-only concern.
 */

function makeEvent(headers: Record<string, string>): H3Event {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  )
  return {
    context: {},
    node: { req: { headers: lower } },
  } as unknown as H3Event
}

/** Records every fetch and answers from a per-path map. */
function stubFetch(responses: Record<string, { status?: number, body?: unknown, text?: string }> = {}) {
  const calls: Array<{ url: string, init: RequestInit }> = []
  const impl = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, init })
    const match = Object.entries(responses).find(([path]) => url.includes(path))
    const { status = 200, body = {}, text = '' } = match?.[1] ?? {}
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => text || JSON.stringify(body),
    } as unknown as Response
  })
  vi.stubGlobal('fetch', impl)
  return calls
}

beforeEach(() => {
  vi.stubGlobal('useRuntimeConfig', () => ({ drupalBaseUrl: 'http://drupal.test/' }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sitePermissions', () => {
  it('reads the permissions off site-info, rendering no page', async () => {
    const calls = stubFetch({ '/api/site-info': { body: { permissions: { 'access administration pages': true } } } })
    const event = makeEvent({ Cookie: 'SESS=x' })
    expect(await sitePermissions(event)).toEqual({ 'access administration pages': true })
    expect(calls[0]!.url).toBe('http://drupal.test/api/site-info?_format=json')
    expect(calls[0]!.init.method ?? 'GET').toBe('GET')
    expect(calls.some(call => call.url.includes('/ce-api/'))).toBe(false)
  })

  it('reads once per request, however many consumers ask', async () => {
    const calls = stubFetch({ '/api/site-info': { body: { permissions: {} } } })
    const event = makeEvent({ Cookie: 'SESS=x' })
    await Promise.all([sitePermissions(event), sitePermissions(event)])
    expect(calls).toHaveLength(1)
  })

  it('answers no permissions when the read fails, so nothing gated is drawn', async () => {
    stubFetch({ '/api/site-info': { status: 503 } })
    expect(await sitePermissions(makeEvent({ Cookie: 'SESS=x' }))).toEqual({})
  })
})

describe('drupalFetch auth forwarding', () => {
  it('forwards a Bearer token, and no cookie rides along', async () => {
    const calls = stubFetch()
    await drupalFetch(makeEvent({ Authorization: 'Bearer tok-1', Cookie: 'SESS=x' }), '/jsonapi/node/kb_page')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok-1')
    expect(headers.Cookie).toBeUndefined()
  })

  it('forwards the session cookie when no token is present', async () => {
    const calls = stubFetch()
    await drupalFetch(makeEvent({ Cookie: 'SESS=x' }), '/jsonapi/node/kb_page')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Cookie).toBe('SESS=x')
    expect(headers.Authorization).toBeUndefined()
  })

  it('sends a cookie-authed write through the CSRF-token dance', async () => {
    const calls = stubFetch({ '/session/token': { text: 'csrf-1' } })
    await drupalFetch(makeEvent({ Cookie: 'SESS=x' }), '/jsonapi/node/kb_page/u-1', { method: 'PATCH', body: '{}' })
    expect(calls.map(c => c.url)).toEqual([
      'http://drupal.test/session/token',
      'http://drupal.test/jsonapi/node/kb_page/u-1',
    ])
    expect((calls[1]!.init.headers as Record<string, string>)['X-CSRF-Token']).toBe('csrf-1')
  })

  it('skips the CSRF-token fetch for a token-authed write', async () => {
    // simple_oauth is not cookie-based; Drupal requires no CSRF token for it.
    const calls = stubFetch()
    await drupalFetch(makeEvent({ Authorization: 'Bearer tok-1' }), '/jsonapi/node/kb_page/u-1', { method: 'PATCH', body: '{}' })
    expect(calls.map(c => c.url)).toEqual(['http://drupal.test/jsonapi/node/kb_page/u-1'])
    expect((calls[0]!.init.headers as Record<string, string>)['X-CSRF-Token']).toBeUndefined()
  })

  it('keeps the captured-cookie path of the headless commit service intact', async () => {
    const calls = stubFetch({ '/session/token': { text: 'csrf-1' } })
    await drupalFetchWithCookie('SESS=captured', '/jsonapi/node/kb_page/u-1', { method: 'PATCH', body: '{}' })
    const headers = calls[1]!.init.headers as Record<string, string>
    expect(headers.Cookie).toBe('SESS=captured')
    expect(headers['X-CSRF-Token']).toBe('csrf-1')
  })
})

/**
 * A space-scoped path resolves to its page through the CE-API: Drupal's
 * alias router serves the `kb_page` `full` display at the alias, and the nid
 * on it drives the existing by-nid read. A path the actor may not view answers
 * 404 there, which becomes `null` here — a private page's nid never leaks.
 */
describe('findKbPageByPath', () => {
  const cePage = {
    content: {
      element: 'node-kb-page',
      props: {
        nid: '3',
        uuid: 'u-3',
        path: '/team-wiki/getting-started',
        title: 'Getting started',
        body: { value: '# Getting started {#b-0}\n\nBody.', format: 'comark' },
        changed: '1782000000',
        space: { uuid: 't-9', name: 'Team wiki' },
      },
    },
  }

  it('reads the whole page off the CE page at the alias', async () => {
    const calls = stubFetch({ '/ce-api/team-wiki/getting-started': { body: cePage } })
    const page = await findKbPageByPath(makeEvent({ Cookie: 'SESS=x' }), 'team-wiki/getting-started')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://drupal.test/ce-api/team-wiki/getting-started')
    expect(page).toEqual({
      id: 'u-3',
      nid: 3,
      path: '/team-wiki/getting-started',
      title: 'Getting started',
      titleHeading: '# Getting started {#b-0}\n\n',
      body: 'Body.',
      changed: 1782000000,
      blockMeta: '',
      space: { id: 't-9', name: 'Team wiki' },
    })
  })

  it('falls back to /node/<nid> when the page carries no alias', async () => {
    const { path: _alias, ...props } = cePage.content.props
    stubFetch({ '/ce-api/team-wiki/getting-started': { body: { content: { element: 'node-kb-page', props } } } })
    const page = await findKbPageByPath(makeEvent({ Cookie: 'SESS=x' }), 'team-wiki/getting-started')
    expect(page?.path).toBe('/node/3')
  })

  it('strips the block anchor a search hit carries', async () => {
    const calls = stubFetch({ '/ce-api/team-wiki/getting-started': { body: cePage } })
    await findKbPageByPath(makeEvent({ Cookie: 'SESS=x' }), '/team-wiki/getting-started#b-0')
    expect(calls[0]!.url).toBe('http://drupal.test/ce-api/team-wiki/getting-started')
  })

  it('strips a trailing .md before hitting the CE-API', async () => {
    const calls = stubFetch({ '/ce-api/team-wiki/getting-started': { body: cePage } })
    await findKbPageByPath(makeEvent({ Cookie: 'SESS=x' }), 'team-wiki/getting-started.md')
    expect(calls[0]!.url).toBe('http://drupal.test/ce-api/team-wiki/getting-started')
  })

  it('returns null on a 404', async () => {
    const calls = stubFetch({ '/ce-api/team-wiki/secret': { status: 404 } })
    expect(await findKbPageByPath(makeEvent({ Cookie: 'SESS=x' }), 'team-wiki/secret')).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('returns null for a path that is not a page', async () => {
    const calls = stubFetch({ '/ce-api/team-wiki': { body: { content: { element: 'node-kb-space', props: {} } } } })
    expect(await findKbPageByPath(makeEvent({ Cookie: 'SESS=x' }), 'team-wiki')).toBeNull()
    expect(calls).toHaveLength(1)
  })
})

/** A `kb_page` CE page by nid, with the tasks Drupal offers this account. */
const page = (body: string, tasks: string[], blockMeta = '') => ({
  content: {
    element: 'node-kb-page',
    props: {
      nid: '3',
      uuid: 'u-3',
      path: '/team-wiki/getting-started',
      title: 'Getting started',
      body: { value: body, format: 'comark' },
      blockMeta,
      changed: '1782000000',
      space: { uuid: 't-9', name: 'Team wiki' },
    },
  },
  local_tasks: { primary: tasks.map(label => ({ label })) },
})
const cookie = { Cookie: 'SESS=x' }

/** A live read of node 3 a caller already holds, as `fetchCeWorkingCopy` takes it. */
const live = (): CePageRead => ({
  page: {
    id: 'u-3',
    nid: 3,
    path: '/team-wiki/getting-started',
    title: 'Getting started',
    titleHeading: '',
    body: 'Live body.',
    changed: 1782000000,
    blockMeta: '',
    space: null,
  },
  props: {},
  canEdit: true,
  hasDraft: true,
})

describe('fetchCeNode', () => {
  it('reads the live revision in one request, tasks and all', async () => {
    const calls = stubFetch({ '/ce-api/node/3': { body: page('Live body.', ['View', 'Edit', 'Latest version']) } })
    const read = await fetchCeNode(cookie, 3)
    expect(calls.map(call => call.url)).toEqual(['http://drupal.test/ce-api/node/3'])
    expect(read).toMatchObject({ canEdit: true, hasDraft: true })
    expect(read.page.body).toBe('Live body.')
  })

  it('raises a refusal with its own status — absent and forbidden stay apart', async () => {
    stubFetch({ '/ce-api/node/3': { status: 403 } })
    await expect(fetchCeNode(cookie, 3)).rejects.toMatchObject({ statusCode: 403 })
    stubFetch({ '/ce-api/node/3': { status: 404 } })
    await expect(fetchCeNode(cookie, 3)).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('fetchCeWorkingCopy', () => {
  it('reads the live revision in one request when no draft task is offered', async () => {
    const calls = stubFetch({ '/ce-api/node/3': { body: page('Live body.', ['View', 'Edit']) } })
    const read = await fetchCeWorkingCopy(cookie, 3)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://drupal.test/ce-api/node/3')
    expect(read.hasDraft).toBe(false)
    expect(read.canEdit).toBe(true)
    expect(read.page.body).toBe('Live body.')
  })

  it('follows the Latest version task to the draft, in a second request', async () => {
    // The draft page's own tasks are not the page's: `canEdit` stays the
    // canonical read's answer.
    const calls = stubFetch({
      '/ce-api/node/3/latest': { body: page('Draft body.', ['View']) },
      '/ce-api/node/3': { body: page('Live body.', ['View', 'Edit', 'Latest version']) },
    })
    const read = await fetchCeWorkingCopy(cookie, 3)
    expect(calls.map(call => call.url)).toEqual([
      'http://drupal.test/ce-api/node/3',
      'http://drupal.test/ce-api/node/3/latest',
    ])
    expect(read.hasDraft).toBe(true)
    expect(read.canEdit).toBe(true)
    expect(read.page.body).toBe('Draft body.')
  })

  it('reads no draft for an account the task is withheld from', async () => {
    const calls = stubFetch({ '/ce-api/node/3': { body: page('Live body.', ['View', 'Revisions']) } })
    const read = await fetchCeWorkingCopy(cookie, 3)
    expect(calls).toHaveLength(1)
    expect(read).toMatchObject({ hasDraft: false, canEdit: false })
    expect(read.page.body).toBe('Live body.')
  })

  // The provenance sidecar is keyed by the block ids of its OWN revision's
  // body, so it has to come off the same read. Paired with the live sidecar
  // instead, it names ids the draft body does not carry; the commit's
  // coherence sweep drops exactly those and an untouched document reads as
  // dirty, minting a checkpoint revision on every visit.
  it('carries the block-provenance sidecar of the revision it read', async () => {
    stubFetch({
      '/ce-api/node/3/latest': { body: page('Draft body.', ['View'], '{"b-draft":{}}') },
      '/ce-api/node/3': { body: page('Live body.', ['View', 'Latest version'], '{"b-live":{}}') },
    })
    const read = await fetchCeWorkingCopy(cookie, 3)
    expect(read.page.body).toBe('Draft body.')
    expect(read.page.blockMeta).toBe('{"b-draft":{}}')
  })

  it('forwards a Bearer token as the only carrier, as the actor rule has it', async () => {
    const calls = stubFetch({ '/ce-api/node/3': { body: page('Live body.', ['View']) } })
    await fetchCeWorkingCopy({ Authorization: 'Bearer t-1' }, 3)
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer t-1')
    expect(headers.Cookie).toBeUndefined()
  })

  it('raises a refusal with its own status rather than answering the live body', async () => {
    stubFetch({ '/ce-api/node/3': { status: 403 } })
    await expect(fetchCeWorkingCopy(cookie, 3)).rejects.toMatchObject({ statusCode: 403 })
  })

  it('raises the hidden-space 404 rather than reading it as an absent page', async () => {
    stubFetch({ '/ce-api/node/3': { status: 404 } })
    await expect(fetchCeWorkingCopy(cookie, 3)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('refuses a nid that is not a page', async () => {
    stubFetch({ '/ce-api/node/3': { body: { content: { element: 'node-kb-space', props: {} } } } })
    await expect(fetchCeWorkingCopy(cookie, 3)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('takes a live read the caller already holds instead of reading it again', async () => {
    const calls = stubFetch({ '/ce-api/node/3/latest': { body: page('Draft body.', ['View']) } })
    const read = await fetchCeWorkingCopy(cookie, 3, live())
    expect(calls.map(call => call.url)).toEqual(['http://drupal.test/ce-api/node/3/latest'])
    expect(read.page.body).toBe('Draft body.')
  })

  it('answers a draft-less live read the caller holds without a request at all', async () => {
    const calls = stubFetch({})
    const read = await fetchCeWorkingCopy(cookie, 3, { ...live(), hasDraft: false })
    expect(calls).toHaveLength(0)
    expect(read.page.body).toBe('Live body.')
  })

  it('ignores a live read of another page and reads this one', async () => {
    const calls = stubFetch({ '/ce-api/node/3': { body: page('Live body.', ['View']) } })
    await fetchCeWorkingCopy(cookie, 3, { ...live(), page: { ...live().page, nid: 4 } })
    expect(calls.map(call => call.url)).toEqual(['http://drupal.test/ce-api/node/3'])
  })
})

describe('fetchCeRevision', () => {
  it('reads one revision off the revision route', async () => {
    const calls = stubFetch({
      '/ce-api/node/3/revisions/12/view': {
        body: {
          content: {
            element: 'node-kb-page',
            props: {
              nid: '3',
              uuid: 'u-3',
              title: 'Getting started',
              body: { value: 'Body as it was.', format: 'comark' },
              changed: '1781000000',
            },
          },
        },
      },
    })
    const read = await fetchCeRevision({ Cookie: 'SESS=x' }, 3, 12)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://drupal.test/ce-api/node/3/revisions/12/view')
    expect(read.page.body).toBe('Body as it was.')
    expect(read.canEdit).toBe(false)
  })

  it('raises a refused revision with its own status', async () => {
    stubFetch({ '/ce-api/node/3/revisions/12/view': { status: 403 } })
    await expect(fetchCeRevision({ Cookie: 'SESS=x' }, 3, 12)).rejects.toMatchObject({ statusCode: 403 })
  })
})

/**
 * OKB-64: how a revision is written. Not a JSON:API PATCH — that transport
 * refuses every write on a page carrying a forward draft (core #2795279),
 * so a session would wedge after its first checkpoint.
 */
describe('commitKbPageWithAuth', () => {
  it('POSTs the payload fragment to the commit route, addressed by nid', async () => {
    const calls = stubFetch({
      '/session/token': { text: 'csrf-1' },
      // The route is core's JSON:API entity resource underneath, so the written
      // revision comes back as a JSON:API document.
      '/openkb/node/7/commit': { body: { data: { attributes: { changed: '2026-07-02T10:00:00+00:00' } } } },
    })

    const written = await commitKbPageWithAuth({ Cookie: 'SESS=x' }, 7, '# Body', {
      attributes: { moderation_state: 'draft' },
      relationships: { field_owner: { data: { type: 'user--user', id: 'u-1' } } },
    })

    expect(written.changed).toBe(Math.floor(Date.parse('2026-07-02T10:00:00+00:00') / 1000))
    expect(written.review).toBeNull()
    const write = calls[1]!
    expect(write.url).toBe('http://drupal.test/openkb/node/7/commit')
    expect(write.init.method).toBe('POST')
    const headers = write.init.headers as Record<string, string>
    // The request body is the bare commit fragment, not a JSON:API document,
    // so it does not claim the media type the bridge defaults to.
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['X-CSRF-Token']).toBe('csrf-1')
    expect(JSON.parse(write.init.body as string)).toEqual({
      attributes: {
        field_kb_body: { value: '# Body' },
        moderation_state: 'draft',
      },
      relationships: { field_owner: { data: { type: 'user--user', id: 'u-1' } } },
    })
  })

  it("carries back Drupal's answer to the sign-offs the payload stated", async () => {
    const review = {
      approved: [{ item: 'b-1', step: 'peer', uid: 7 }],
      refused: [{ item: 'b-2', step: 'peer', uid: 7, reason: 'Block b-2 needs a second pair of eyes: its only contributor is the account approving it.' }],
    }
    stubFetch({
      '/openkb/node/7/commit': {
        body: { data: { attributes: { changed: '2026-07-02T10:00:00+00:00' } }, meta: { review } },
      },
    })

    const written = await commitKbPageWithAuth({ Cookie: 'SESS=x' }, 7, '# Body', {
      session: { actions: [{ item: 'b-1', step: 'peer', uid: 7 }] },
    })

    expect(written.review).toEqual(review)
  })
})

/**
 * The format a body is stored under is Drupal's answer — the body field's own,
 * filled in on presave — so no write path here names one.
 */
describe("the body's text format", () => {
  it('is left to Drupal on every write path', async () => {
    const calls = stubFetch({
      '/openkb/node/7/commit': { body: { data: { attributes: { changed: '2026-07-02T10:00:00+00:00' } } } },
      '/jsonapi/node/kb_page': { body: { data: { id: 'u-1', attributes: { drupal_internal__nid: 7 } } } },
    })
    const auth = { Authorization: 'Bearer tok-1' }

    await patchKbPageWithAuth(auth, 'u-1', '# Patched')
    await commitKbPageWithAuth(auth, 7, '# Committed')
    await createKbPage(makeEvent(auth), { title: 'New', spaceId: 's-1', body: '# Created' })

    const bodies = calls
      .filter(call => call.init.body !== undefined)
      .map(call => JSON.parse(call.init.body as string))
      .map(payload => (payload.data?.attributes ?? payload.attributes).field_kb_body)
    expect(bodies).toEqual([
      { value: '# Patched' },
      { value: '# Committed' },
      { value: '# Created' },
    ])
  })
})

/**
 * OKB-97: the delete path. Two things are load-bearing beyond the request
 * itself — access is Drupal's answer, and an InnoDB deadlock is a retry request
 * rather than a verdict (OKB-90).
 */
describe('probeDeleteAccess', () => {
  it('probes the delete-form route under the forwarded carrier', async () => {
    const calls = stubFetch({ '/node/7/delete': { status: 200 } })
    await expect(probeDeleteAccess(makeEvent({ Cookie: 'SESS=x' }), 7))
      .resolves.toEqual({ allowed: true, missing: false })
    expect(calls[0]!.url).toBe('http://drupal.test/node/7/delete')
    expect(calls[0]!.init.method).toBe('HEAD')
    expect((calls[0]!.init.headers as Record<string, string>).Cookie).toBe('SESS=x')
  })

  it('answers no for a refused probe, and asks nothing without a carrier', async () => {
    const calls = stubFetch({ '/node/7/delete': { status: 403 } })
    await expect(probeDeleteAccess(makeEvent({ Cookie: 'SESS=x' }), 7))
      .resolves.toEqual({ allowed: false, missing: false })
    await expect(probeDeleteAccess(makeEvent({}), 7))
      .resolves.toEqual({ allowed: false, missing: false })
    expect(calls).toHaveLength(1)
  })

  // The distinction the route needs to answer 404 vs 403: refused and absent
  // are different answers, and only this probe can tell them apart.
  it('reports an absent node as missing rather than as a refusal', async () => {
    stubFetch({ '/node/7/delete': { status: 404 } })
    await expect(probeDeleteAccess(makeEvent({ Cookie: 'SESS=x' }), 7))
      .resolves.toEqual({ allowed: false, missing: true })
  })
})

describe('deleteKbPageWithAuth', () => {
  const DEADLOCK = 'SQLSTATE[40001]: Serialization failure: 1213 Deadlock found when trying to get lock'

  /** Answers the DELETE from a queue, so a retry can get a different outcome. */
  function stubDeleteSequence(statuses: Array<{ status: number, text?: string }>) {
    const calls: string[] = []
    const queue = [...statuses]
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input)
      calls.push(`${(init.method ?? 'GET')} ${url}`)
      if (url.includes('/session/token')) {
        return { ok: true, status: 200, text: async () => 'csrf-1' } as unknown as Response
      }
      const next = queue.shift() ?? { status: 500 }
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        text: async () => next.text ?? '',
      } as unknown as Response
    }))
    return calls
  }

  it('DELETEs once, CSRF-token first, on the happy path', async () => {
    const calls = stubDeleteSequence([{ status: 204 }])
    await deleteKbPageWithAuth({ Cookie: 'SESS=x' }, 'u-1')
    expect(calls).toEqual([
      'GET http://drupal.test/session/token',
      'DELETE http://drupal.test/jsonapi/node/kb_page/u-1',
    ])
  })

  it('retries a deadlock and succeeds, without re-fetching the CSRF token', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const calls = stubDeleteSequence([
      { status: 500, text: DEADLOCK },
      { status: 204 },
    ])
    const done = deleteKbPageWithAuth({ Cookie: 'SESS=x' }, 'u-1')
    await vi.advanceTimersByTimeAsync(2000)
    await expect(done).resolves.toBeUndefined()
    expect(calls.filter(c => c.includes('/session/token'))).toHaveLength(1)
    expect(calls.filter(c => c.startsWith('DELETE'))).toHaveLength(2)
    vi.useRealTimers()
  })

  it('treats a 404 after a retry as deleted', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubDeleteSequence([{ status: 500, text: DEADLOCK }, { status: 404 }])
    const done = deleteKbPageWithAuth({ Cookie: 'SESS=x' }, 'u-1')
    await vi.advanceTimersByTimeAsync(2000)
    await expect(done).resolves.toBeUndefined()
    vi.useRealTimers()
  })

  it('does not retry a non-deadlock failure, and reports it as the class it is', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const calls = stubDeleteSequence([{ status: 403, text: 'forbidden' }])
    await expect(deleteKbPageWithAuth({ Cookie: 'SESS=x' }, 'u-1'))
      .rejects.toMatchObject({ statusCode: 403 })
    expect(calls.filter(c => c.startsWith('DELETE'))).toHaveLength(1)
  })

  it('gives up after the attempt budget, mapping the last 500 to 503', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const calls = stubDeleteSequence(Array.from({ length: 3 }, () => ({ status: 500, text: DEADLOCK })))
    // Assert on the rejection before advancing the clock: attaching the
    // handler afterwards leaves the rejection momentarily unhandled, which
    // vitest reports as an unhandled error.
    const done = expect(deleteKbPageWithAuth({ Cookie: 'SESS=x' }, 'u-1'))
      .rejects.toMatchObject({ statusCode: 503 })
    await vi.advanceTimersByTimeAsync(5000)
    await done
    expect(calls.filter(c => c.startsWith('DELETE'))).toHaveLength(3)
    vi.useRealTimers()
  })
})
