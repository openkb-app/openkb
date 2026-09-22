import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { DrupalJsonApiParams } from 'drupal-jsonapi-params'
import * as Y from 'yjs'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import WebSocket from 'ws'
import {
  blockMetaRoot,
  contributorsSince,
  fieldKey,
  isPending,
  mayApprove,
  parseBlockMeta,
  readBlockMeta,
  type PageBlock,
  type BlockMetaMap,
} from '#shared/page-blocks'
import { messageKey, type InlineCommentRecord } from '#shared/block-comments'

/**
 * WS bridge integration test — real client against the running dev server.
 *
 * Pins the crossws bridge in server/routes/collaboration.ts (the
 * `as unknown as` casts between h3's peer objects and
 * `Hocuspocus.handleConnection`) against hocuspocus / crossws API drift:
 * handshake, cookie auth against Drupal, initial sync, and update fan-out
 * all have to survive for these tests to pass. First tripwire for the
 * hocuspocus 4.x bump (OKB-8) and later Nitro v3.
 *
 * Needs the full docker stack (Drupal + frontend dev server). The `.integration`
 * name puts it in the `integration` vitest project (vitest.config.ts), out of
 * the default `unit` run; run it against a live stack with:
 *
 *   docker compose exec -T frontend npx vitest run --project integration
 */

// The port the surrounding frontend container listens on: local stacks raise it
// to the published host port so the advertised frontend URL is valid
// in-network too; elsewhere it is nitro's 3000.
const PORT = process.env.NUXT_PORT ?? process.env.NITRO_PORT ?? '3000'
const WS_URL = process.env.OKB_COLLAB_WS_URL ?? `ws://127.0.0.1:${PORT}/collaboration`
const DRUPAL_URL = (process.env.DRUPAL_BASE_URL ?? 'http://openkb-dev-project.localdev.space:8081').replace(/\/$/, '')
const DOC_NAME = 'node:1'
const NUXT_URL = (process.env.OKB_NUXT_URL ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, '')

async function drupalAdminCookie(): Promise<string> {
  const body = new URLSearchParams({
    name: 'admin',
    pass: process.env.OKB_ADMIN_PASS ?? 'lupus123',
    form_id: 'user_login_form',
    op: 'Log in',
  })
  const res = await fetch(`${DRUPAL_URL}/user/login`, {
    method: 'POST',
    body,
    redirect: 'manual',
  })
  const cookie = res.headers
    .getSetCookie()
    .map(c => c.split(';')[0])
    .find(c => /^S?SESS/.test(c))
  if (!cookie) {
    throw new Error(`Drupal login failed (status ${res.status}, no SESS cookie)`)
  }
  return cookie
}

interface Session {
  provider: HocuspocusProvider
  socket: HocuspocusProviderWebsocket
  doc: Y.Doc
}

/**
 * A `ws` client that puts the session cookie where a browser puts it.
 *
 * The collab server derives identity from the handshake's Cookie header and
 * refuses any credential handed in through the hocuspocus `token`, so a test
 * authenticating the easy way would be testing a door the product does not
 * have.
 */
function cookieWebSocket(cookie: string | null): typeof WebSocket {
  return class extends WebSocket {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols, cookie ? { headers: { Cookie: cookie } } : {})
    }
  } as unknown as typeof WebSocket
}

function connect(cookie: string | null, docName: string = DOC_NAME, timeoutMs = 15_000): Promise<Session> {
  const doc = new Y.Doc()
  const socket = new HocuspocusProviderWebsocket({
    url: WS_URL,
    WebSocketPolyfill: cookieWebSocket(cookie),
  })
  return new Promise<Session>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no sync within ${timeoutMs}ms`)),
      timeoutMs,
    )
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: docName,
      document: doc,
      onSynced: () => {
        clearTimeout(timer)
        resolve({ provider, socket, doc })
      },
      onAuthenticationFailed: ({ reason }) => {
        clearTimeout(timer)
        reject(new Error(`authentication failed: ${reason}`))
      },
    })
    // With an explicit websocketProvider the provider does not attach
    // itself (4.x only auto-attaches when it manages its own socket).
    provider.attach()
  })
}

/**
 * Resolves once the server holds every write this session has sent.
 *
 * A local transaction is queued on the socket; the commit RPC is a different
 * channel, and asking for one straight after typing can be served against a
 * document that does not hold the typing yet — the commit then finds nothing to
 * write and reports itself clean.
 *
 * The provider counts its own outstanding updates: each local transaction
 * increments the counter, and the server decrements it by acknowledging that
 * update — after applying it, in the order it arrived. A drained counter is
 * therefore the server saying it holds all of them.
 *
 * `provider.forceSync()` is deliberately not part of this. It *resets* the
 * counter to one rather than adding to it, so a session with several updates in
 * flight is released by the first acknowledgement while the rest are still
 * queued behind it — a barrier that waits for one write out of three.
 */
async function flushed({ provider }: Session, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (provider.hasUnsyncedChanges) {
    if (Date.now() > deadline) throw new Error(`updates not acknowledged within ${timeoutMs}ms`)
    await new Promise(r => setTimeout(r, 20))
  }
}

function waitForKey(doc: Y.Doc, key: string, timeoutMs = 10_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const map = doc.getMap('_test')
    const check = (): void => {
      if (map.has(key)) {
        map.unobserve(check)
        resolve(map.get(key))
      }
    }
    map.observe(check)
    check()
    setTimeout(() => reject(new Error(`no ${key} within ${timeoutMs}ms`)), timeoutMs)
  })
}

async function pageOf(cookie: string, nid: number): Promise<{ changed: number, body: string }> {
  const res = await fetch(`${NUXT_URL}/api/node/${nid}`, { headers: { Cookie: cookie } })
  return await res.json() as { changed: number, body: string }
}

/**
 * Poll until Drupal's body holds `marker`; answers the node's `changed` then.
 *
 * The write, not its timestamp: `changed` is second-granular, so a commit
 * landing in the same second as the write before it carries the identical
 * value and a wait on the number advancing never ends.
 */
async function waitForBody(cookie: string, nid: number, marker: string, timeoutMs = 20_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let page = await pageOf(cookie, nid)
  while (Date.now() < deadline) {
    if (page.body.includes(marker)) return page.changed
    await new Promise(r => setTimeout(r, 100))
    page = await pageOf(cookie, nid)
  }
  throw new Error(`Drupal's body did not carry ${marker} within ${timeoutMs}ms: ${JSON.stringify(page.body)}`)
}

/**
 * Write the body straight to Drupal, bypassing the editor — the same "external
 * agent" path the e2e suite uses. Returns the new `changed`.
 */
async function patchBody(cookie: string, nid: number, body: string): Promise<number> {
  const res = await fetch(`${NUXT_URL}/api/node/${nid}`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, expected_changed: 0 }),
  })
  if (!res.ok) throw new Error(`PATCH /api/node/${nid} ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return ((await res.json()) as { changed: number }).changed
}

/**
 * Save to history through the frontend's own RPC — the same pipeline the
 * editor's Save button and the auto-checkpoints use (`commitDocument` with the
 * fields + block-id hooks), against the live session.
 *
 * Used instead of waiting on the last-peer-disconnect checkpoint: whether that
 * trigger fires promptly is its own concern, covered by the warm-document test
 * above, and hanging a provenance assertion off it only makes this test slower
 * and flakier without testing more of the provenance path.
 */
async function commitNow(cookie: string, nid: number): Promise<{ ok: boolean, committed: boolean }> {
  const res = await fetch(`${NUXT_URL}/api/node/${nid}/commit`, {
    method: 'POST',
    headers: { Cookie: cookie },
  })
  if (!res.ok) throw new Error(`POST /api/node/${nid}/commit ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return await res.json() as { ok: boolean, committed: boolean }
}

async function jsonApi<T>(cookie: string, path: string, init: RequestInit = {}): Promise<T> {
  const csrf = await (await fetch(`${DRUPAL_URL}/session/token`, { headers: { Cookie: cookie } })).text()
  const res = await fetch(`${DRUPAL_URL}${path}`, {
    ...init,
    headers: {
      Cookie: cookie,
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      'X-CSRF-Token': csrf,
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok && res.status !== 204) {
    throw new Error(`${init.method ?? 'GET'} ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  return res.status === 204 ? ({} as T) : await res.json() as T
}

/** UUID of a user, for seeding an entity-reference field. */
async function userUuid(cookie: string, name: string): Promise<string> {
  const params = new DrupalJsonApiParams().addFilter('name', name).addPageLimit(1)
  const json = await jsonApi<{ data: Array<{ id: string }> }>(
    cookie,
    `/jsonapi/user/user?${params.getQueryString({ encodeValuesOnly: true })}`,
  )
  const uuid = json.data?.[0]?.id
  if (!uuid) throw new Error(`no user ${name}`)
  return uuid
}

/** The other peer's burst has fanned out to this doc — a sync barrier. */
function waitForText(doc: Y.Doc, needle: string, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const check = (): void => {
      if (doc.getXmlFragment('default').toString().includes(needle)) return resolve()
      if (Date.now() > deadline) return reject(new Error(`"${needle}" never fanned out within ${timeoutMs}ms`))
      setTimeout(check, 100)
    }
    check()
  })
}

/** A space to file probe pages in — field_space is required on the type. */
let spaceUuid: string | undefined
async function probeSpace(cookie: string): Promise<string> {
  if (!spaceUuid) {
    const json = await jsonApi<{ data: { id: string }[] }>(cookie, '/jsonapi/openkb_space/openkb_space')
    const first = json.data[0]
    if (!first) {
      throw new Error('No space to file a probe page in')
    }
    spaceUuid = first.id
  }
  return spaceUuid
}

/** Throwaway page, so a test that rewrites a body never touches node:1. */
async function createPage(cookie: string, body: string): Promise<{ uuid: string, nid: number }> {
  const slug = `collab-probe-${Date.now()}`
  const space = await probeSpace(cookie)
  const json = await jsonApi<{ data: { id: string, attributes: { drupal_internal__nid: number } } }>(
    cookie,
    '/jsonapi/node/kb_page',
    {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'node--kb_page',
          attributes: {
            title: `Collab integration probe ${slug}`,
            field_kb_body: { value: body, format: 'comark' },
            path: { alias: `/general/${slug}`, pathauto: 0 },
          },
          relationships: {
            field_space: { data: { type: 'openkb_space--openkb_space', id: space } },
          },
        },
      }),
    },
  )
  return { uuid: json.data.id, nid: json.data.attributes.drupal_internal__nid }
}

/**
 * The sidecar as Drupal stored it, read off the working copy.
 *
 * kb_page is moderated (OKB-64) and every checkpoint lands as a Draft
 * revision, so the revision a commit just wrote is the working copy — the
 * default revision is whatever was last published. Addressing it explicitly
 * keeps the assertion about the commit rather than about the probe's
 * publication state.
 */
async function storedBlockMeta(cookie: string, uuid: string): Promise<Record<string, PageBlock>> {
  const stored = await jsonApi<{ data: { attributes: { field_block_meta: string | null } } }>(
    cookie,
    `/jsonapi/node/kb_page/${uuid}?resourceVersion=rel%3Aworking-copy`,
  )
  return parseBlockMeta(stored.data.attributes.field_block_meta)
}

/**
 * The body Drupal stored, read off the working copy for the same reason
 * {@link storedBlockMeta} is.
 */
async function storedBody(cookie: string, uuid: string): Promise<string> {
  const stored = await jsonApi<{ data: { attributes: { field_kb_body: { value: string } | null } } }>(
    cookie,
    `/jsonapi/node/kb_page/${uuid}?resourceVersion=rel%3Aworking-copy`,
  )
  return stored.data.attributes.field_kb_body?.value ?? ''
}

/**
 * The account the page's latest revision is filed under.
 *
 * A collaborative checkpoint carries several peers' writing under whichever
 * peer's cookie the collab server captured last, so what this reads is whether
 * the revision names the human who did the work or the one who happened to
 * carry the save.
 */
async function revisionAuthorUid(cookie: string, uuid: string): Promise<number> {
  const stored = await jsonApi<{ included?: Array<{ attributes?: { drupal_internal__uid?: number } }> }>(
    cookie,
    `/jsonapi/node/kb_page/${uuid}?resourceVersion=rel%3Aworking-copy&include=revision_uid`,
  )
  return Number(stored.included?.[0]?.attributes?.drupal_internal__uid ?? 0)
}

/**
 * The conversations Drupal durably holds about a page (ADR 0006).
 *
 * The generic inline-comment API rather than a field on the page:
 * conversations are internal entities beside it, so nothing else serves them.
 */
/** Polls the stored conversations until they satisfy `until`, or gives up. */
async function waitForStoredComments(
  cookie: string,
  nid: number,
  until: (messages: InlineCommentRecord[]) => boolean,
  timeoutMs = 30_000,
): Promise<InlineCommentRecord[]> {
  const deadline = Date.now() + timeoutMs
  let last: InlineCommentRecord[] = []
  while (Date.now() < deadline) {
    last = await storedComments(cookie, nid)
    if (until(last)) return last
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`conversations never settled: ${JSON.stringify(last)}`)
}

async function storedComments(cookie: string, nid: number): Promise<InlineCommentRecord[]> {
  const query = new URLSearchParams({ entity_type: 'node', entity_id: String(nid) })
  const res = await fetch(`${DRUPAL_URL}/api/inline-comments?${query}`, {
    headers: { Cookie: cookie, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`GET conversations ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return ((await res.json()) as { messages: InlineCommentRecord[] }).messages
}

async function deletePage(cookie: string, uuid: string): Promise<void> {
  await jsonApi(cookie, `/jsonapi/node/kb_page/${uuid}`, { method: 'DELETE' })
}

/**
 * Puts id-bearing paragraphs into the shared document, the way a browser
 * peer's editor does when it hydrates from Drupal's markdown — and only the
 * ones it does not already hold.
 *
 * This is hydration, not the typing, and it is a **no-op for a block the
 * document already carries** — whatever text it is asked to seed. Which of the
 * two it is depends on state no test controls: the fragment arrives empty when
 * this session is what hydrates the page, and already full when the server
 * restored it (the snapshot store, or a reconcile that wrote Drupal's markdown
 * into it). So a test that needs the body to *change* has to type the change
 * after seeding, rather than smuggle it in as a differently-worded seed: worded
 * that way it changes nothing wherever the block was already there, and the
 * checkpoint that follows has nothing to write.
 *
 * A document that arrives non-empty is ordinary rather than exceptional — the
 * snapshot store keeps it under `node:<nid>`, and a node id Drupal reissues
 * brings the previous page's copy back with it (see "a document that comes
 * back on another page"). Appending regardless would put two blocks under
 * one id, and that state is invisible to the whole block model:
 * `blockTextLengths` keys by id, so the second copy hides the first and typing
 * into either measures as no growth at all — nothing is credited and the live
 * sidecar stops moving. A browser never produces it (the commit's id hygiene
 * re-mints a duplicate into a new block), so a test that manufactures it is
 * measuring a page no editor can create.
 */
function seedBlocks(doc: Y.Doc, blocks: Array<{ id: string, text: string }>): void {
  const fragment = doc.getXmlFragment('default')
  const held = new Set(fragment.toArray()
    .map(node => (node instanceof Y.XmlElement ? node.getAttribute('id') : null))
    .filter((id): id is string => typeof id === 'string'))
  doc.transact(() => {
    for (const { id, text } of blocks) {
      if (held.has(id)) continue
      const paragraph = new Y.XmlElement('paragraph')
      paragraph.setAttribute('id', id)
      paragraph.insert(0, [new Y.XmlText(text)])
      fragment.insert(fragment.length, [paragraph])
    }
  })
}

/**
 * Types into a block that is already in the document, the way a caret in it
 * does: the text goes into that paragraph's own Y.XmlText, so it stays the
 * same block.
 */
function typeInto(doc: Y.Doc, blockId: string, text: string): void {
  const nodes = doc.getXmlFragment('default').toArray()
  const paragraph = nodes
    .find(node => node instanceof Y.XmlElement && node.getAttribute('id') === blockId) as Y.XmlElement | undefined
  if (!paragraph) {
    throw new Error(`no block ${blockId} in the document; it holds `
      + JSON.stringify(nodes.map(n => n instanceof Y.XmlElement ? [n.nodeName, n.getAttribute('id')] : String(n))))
  }
  const run = paragraph.get(0) as Y.XmlText
  doc.transact(() => run.insert(run.length, text))
}

/**
 * Deletes the tail of a block, the way backspacing in it does.
 *
 * The edit that grows nothing: it is real writing, it opens a review episode,
 * and the session's character accounting has no growth to book for it. Whose
 * episode it is has to come out of the checkpoint anyway.
 */
function deleteFrom(doc: Y.Doc, blockId: string, chars: number): void {
  const paragraph = doc.getXmlFragment('default').toArray()
    .find(node => node instanceof Y.XmlElement && node.getAttribute('id') === blockId) as Y.XmlElement | undefined
  if (!paragraph) throw new Error(`no block ${blockId} in the document`)
  const run = paragraph.get(0) as Y.XmlText
  doc.transact(() => run.delete(Math.max(0, run.length - chars), Math.min(chars, run.length)))
}

describe('collaboration WS bridge', () => {
  let cookie: string
  const sessions: Session[] = []

  async function open(sessionCookie: string | null, docName?: string): Promise<Session> {
    const session = await connect(sessionCookie, docName)
    sessions.push(session)
    return session
  }

  beforeAll(async () => {
    cookie = await drupalAdminCookie()
  })

  afterEach(() => {
    for (const { provider, socket } of sessions.splice(0)) {
      provider.destroy()
      socket.destroy()
    }
  })

  it('completes handshake, auth and initial sync for node:1', { timeout: 20_000 }, async () => {
    const { provider } = await open(cookie)
    expect(provider.isSynced).toBe(true)
    expect(provider.isAuthenticated).toBe(true)
  })

  it('round-trips a doc update between two clients', { timeout: 30_000 }, async () => {
    const key = `probe-${Date.now()}`
    const value = `okb-11-${Math.random().toString(36).slice(2)}`

    const writer = await open(cookie)
    writer.doc.getMap('_test').set(key, value)

    const reader = await open(cookie)
    await expect(waitForKey(reader.doc, key)).resolves.toBe(value)

    // Leave nothing behind in the shared document.
    writer.doc.getMap('_test').delete(key)
  })

  it('rejects a connection without a session cookie', { timeout: 20_000 }, async () => {
    await expect(open(null)).rejects.toThrow(/authentication failed/i)
  })

  /**
   * Case 9: no credential a client declares gets a seat at the document.
   *
   * The handshake carries the browser's HttpOnly cookie by itself, so the
   * `token` channel exists only for something that had to name its own
   * credential — an agent's Bearer token above all. Honouring it would seat a
   * writer whose identity nobody derived, putting ops into the document that
   * nobody witnessed. An agent reaches the document the other way, in-process
   * through the agent adapter (ADR 0003), where the session router decides
   * admission. Refused even alongside a cookie Drupal would otherwise honour.
   */
  it('refuses a handshake that declares a credential, cookie or not', { timeout: 20_000 }, async () => {
    const declaring = (sessionCookie: string | null): Promise<Session> => {
      const doc = new Y.Doc()
      const socket = new HocuspocusProviderWebsocket({
        url: WS_URL,
        WebSocketPolyfill: cookieWebSocket(sessionCookie),
      })
      return new Promise<Session>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no sync within 15000ms')), 15_000)
        const provider = new HocuspocusProvider({
          websocketProvider: socket,
          name: DOC_NAME,
          document: doc,
          token: 'okb-agent-token',
          onSynced: () => {
            clearTimeout(timer)
            sessions.push({ provider, socket, doc })
            resolve({ provider, socket, doc })
          },
          onAuthenticationFailed: ({ reason }) => {
            clearTimeout(timer)
            provider.destroy()
            socket.destroy()
            reject(new Error(`authentication failed: ${reason}`))
          },
        })
        provider.attach()
      })
    }

    await expect(declaring(cookie)).rejects.toThrow(/agent credentials|authentication failed/i)
    await expect(declaring(null)).rejects.toThrow(/agent credentials|authentication failed/i)
  })

  /**
   * Regression for the seeding hierarchy: a document that is still warm in
   * memory (unload lost the race against the store flush or the next editor)
   * must still be reconciled against Drupal when the next session opens, not
   * served from the stale hot state. Reproduces the CI-flaky
   * `hydrates from Drupal after an external API patch` e2e at the protocol
   * level, without a browser.
   */
  it('a session-less warm document is reseeded from Drupal', { timeout: 60_000 }, async () => {
    // Its own throwaway page: this test rewrites the body, and node:1 is
    // shared with the other suites.
    const probe = await createPage(cookie, '# Collab probe\n\nseed body\n')
    const docName = `node:${probe.nid}`
    try {
      const first = await open(cookie, docName)
      const before = Number(first.doc.getMap('_meta').get('drupal_changed') ?? 0)
      expect(before).toBeGreaterThan(0)

      // Leave the session dirty so the last-peer-disconnect checkpoint actually
      // commits — its `_meta` writes are what keep the document loaded for a
      // moment after the last peer leaves. The server has to hold the write
      // before the socket goes: a peer leaving with its update still in flight
      // leaves a document equal to Drupal, and a checkpoint of that commits
      // nothing.
      const typed = `warm-doc session ${Date.now()}`
      const paragraph = new Y.XmlElement('paragraph')
      paragraph.insert(0, [new Y.XmlText(typed)])
      first.doc.getXmlFragment('default').insert(0, [paragraph])
      await flushed(first)

      first.provider.destroy()
      first.socket.destroy()
      sessions.splice(sessions.indexOf(first), 1)

      // Let the checkpoint land before writing externally: PATCHing while it is
      // in flight races Drupal's own write, not the seeding path under test.
      const committed = await waitForBody(cookie, probe.nid, typed)

      // External write — an agent or another tab, with nobody editing. Not
      // asserted to be strictly newer: Drupal's `changed` is second-granular,
      // so a write in the same second as the checkpoint carries the identical
      // timestamp, which the reconcile has to catch on content instead.
      const marker = `probe-${Date.now()}`
      const changed = await patchBody(cookie, probe.nid, `${marker}\n`)
      expect(changed).toBeGreaterThanOrEqual(committed)

      const second = await open(cookie, docName)
      const meta = second.doc.getMap('_meta')
      // Nothing of the previous session survives to shadow Drupal: the reset
      // replaces the stale fragment with Drupal's body in the same
      // transaction. It is never handed over empty — a disconnect checkpoint
      // firing into an empty window would commit that emptiness.
      const fragment = second.doc.getXmlFragment('default')
      expect(fragment.length).toBeGreaterThan(0)
      expect(fragment.toString()).toContain(marker)
      expect(fragment.toString()).not.toContain('warm-doc session')
      expect(Number(meta.get('drupal_changed'))).toBe(changed)
      expect(meta.get('external_change_detected')).toBeUndefined()
    }
    finally {
      await deletePage(cookie, probe.uuid)
    }
  })

  /**
   * A conversation becomes durable, and does it without touching the page.
   *
   * The whole of what OKB-127 adds, in one pass: what a peer typed into the
   * live map is in Drupal once a checkpoint has run — every message of it,
   * under the account the server witnessed and carrying what was said exactly
   * as the map holds it, filed beside the page so no revision of the
   * page holds a word of it. A checkpoint states the whole map, so a
   * message deleted from it leaves Drupal too, and restating an unchanged map
   * changes nothing.
   *
   * And it lands with **no peer credential in play**: the last message is said
   * and the peer then leaves, so the checkpoint that delivers it is the
   * disconnect one, running under the server's own OAuth client with nobody
   * connected (ADR 0001).
   *
   * Cross-database id reissue is not defended against (ADR 0008) —
   * environments keep store and database coherent.
   */
  it('a conversation lands in Drupal at the checkpoint, beside the page', { timeout: 90_000 }, async () => {
    const probe = await createPage(cookie, 'something to discuss {#b-note}\n')
    const docName = `node:${probe.nid}`
    const said = `note-${Date.now()}`
    const anchor = { from: 0, to: 9, quote: 'something' }
    const note = { uid: 1, at: 1, text: said, via: 'Claude', anchor }
    const act = { uid: 1, at: 2, resolved: true }
    try {
      const session = await open(cookie, docName)
      // The seed leaves hydration to the first client, which here is this
      // test: the block has to carry the id it is commented on, or the commit
      // writes a body Drupal then sweeps the conversation out of.
      const paragraph = new Y.XmlElement('paragraph')
      paragraph.setAttribute('id', 'b-note')
      paragraph.insert(0, [new Y.XmlText('something to discuss')])
      session.doc.getXmlFragment('default').insert(0, [paragraph])
      // A thread and the act that gives it a standing.
      session.doc.getMap('comments').set(messageKey('b-note', 'c-1', 'm-1'), note)
      session.doc.getMap('comments').set(messageKey('b-note', 'c-1', 'm-2'), act)
      await flushed(session)
      await commitNow(cookie, probe.nid)

      const stored = await storedComments(cookie, probe.nid)
      expect(stored).toHaveLength(2)
      expect(stored[0]).toEqual({
        anchor: 'b-note',
        thread_id: 'c-1',
        msg_id: 'm-1',
        uid: 1,
        data: note,
      })
      expect(stored[1]).toMatchObject({ msg_id: 'm-2', data: act })

      // And the page itself carries no trace of it: a conversation is not
      // content and not gate data.
      expect(await storedBody(cookie, probe.uuid)).not.toContain(said)
      expect(JSON.stringify(await storedBlockMeta(cookie, probe.uuid))).not.toContain(said)

      // Restating an unchanged map changes nothing.
      await commitNow(cookie, probe.nid)
      expect(await storedComments(cookie, probe.nid)).toHaveLength(2)

      // A message the map no longer holds leaves Drupal with the next
      // statement — the durable side is a mirror, not an archive.
      session.doc.getMap('comments').delete(messageKey('b-note', 'c-1', 'm-2'))
      await flushed(session)
      await commitNow(cookie, probe.nid)
      expect((await storedComments(cookie, probe.nid)).map(m => m.msg_id)).toEqual(['m-1'])

      // A parting word, delivered by the disconnect checkpoint alone: nothing
      // below calls the commit RPC, and no peer is connected when it runs.
      const parting = { uid: 1, at: 3, text: `parting-${said}` }
      session.doc.getMap('comments').set(messageKey('b-note', 'c-2', 'm-3'), parting)
      await flushed(session)
      session.provider.destroy()
      session.socket.destroy()
      sessions.splice(sessions.indexOf(session), 1)

      const delivered = await waitForStoredComments(
        cookie,
        probe.nid,
        messages => messages.some(m => m.msg_id === 'm-3'),
      )
      expect(delivered.find(m => m.msg_id === 'm-3')).toEqual({
        anchor: 'b-note',
        thread_id: 'c-2',
        msg_id: 'm-3',
        uid: 1,
        data: parting,
      })

      // And the whole conversation outlives the session that said it.
      const second = await open(cookie, docName)
      expect([...second.doc.getMap('comments').values()])
        .toEqual(expect.arrayContaining([note, parting]))
    }
    finally {
      await deletePage(cookie, probe.uuid)
    }
  })
})

/**
 * Entity fields (OKB-46) — the `fields` Y.Map lane, end to end against the
 * real schema endpoint and JSON:API. What a browser adds on top is the form
 * (OKB-47); the session semantics are all here.
 */
describe('collaboration entity fields', () => {
  let cookie: string
  const sessions: Session[] = []

  async function open(docName: string): Promise<Session> {
    const session = await connect(cookie, docName)
    sessions.push(session)
    return session
  }

  beforeAll(async () => {
    cookie = await drupalAdminCookie()
  })

  afterEach(() => {
    for (const { provider, socket } of sessions.splice(0)) {
      provider.destroy()
      socket.destroy()
    }
  })

  it('seeds the fields map from Drupal, references denormalized', { timeout: 60_000 }, async () => {
    const probe = await createPage(cookie, '# Fields probe\n\nbody\n')
    try {
      const owner = await userUuid(cookie, 'admin')
      await jsonApi(cookie, `/jsonapi/node/kb_page/${probe.uuid}`, {
        method: 'PATCH',
        body: JSON.stringify({
          data: {
            type: 'node--kb_page',
            id: probe.uuid,
            attributes: { field_type: 'adr', field_summary: 'Seeded abstract.' },
            relationships: { field_owner: { data: { type: 'user--user', id: owner } } },
          },
        }),
      })

      const { doc } = await open(`node:${probe.nid}`)
      const fields = doc.getMap('fields')

      expect(fields.get('type')).toBe('adr')
      expect(fields.get('summary')).toBe('Seeded abstract.')
      expect(fields.get('owner')).toEqual({ id: owner, label: 'admin' })
      expect(fields.get('title')).toContain('Collab integration probe')
      // Exposure is the frontmatter form display's call, not this test's — the
      // baseline and the live map only have to address the same key *set*.
      // Order is not a contract: the baseline is a plain object (insertion
      // order), `fields` is a Y.Map (hash order).
      expect(Object.keys(doc.getMap('_meta').get('fields_baseline') as object).sort())
        .toEqual([...fields.keys()].sort())
    }
    finally {
      await deletePage(cookie, probe.uuid)
    }
  })

  it('propagates a field edit between two live clients', { timeout: 60_000 }, async () => {
    const probe = await createPage(cookie, '# Fields probe\n\nbody\n')
    try {
      const docName = `node:${probe.nid}`
      const writer = await open(docName)
      const reader = await open(docName)
      const value = `written by a peer ${Date.now()}`

      writer.doc.getMap('fields').set('summary', value)

      await expect(new Promise((resolve, reject) => {
        const fields = reader.doc.getMap('fields')
        const check = (): void => {
          if (fields.get('summary') === value) { fields.unobserve(check); resolve(value) }
        }
        fields.observe(check)
        check()
        setTimeout(() => reject(new Error('field did not propagate within 10s')), 10_000)
      })).resolves.toBe(value)
    }
    finally {
      await deletePage(cookie, probe.uuid)
    }
  })
})

/**
 * Block attribution against the live stack — the proof that nobody but the
 * servers writes it.
 *
 * The unit tests pin the accounting (server/utils/collab-attribution.test.ts)
 * and the flag rules (the Drupal suites). What only a live stack can show is
 * the loop between them: a peer types into the shared document, the collab
 * server credits the connection it authenticated, the checkpoint carries the
 * text to Drupal, Drupal's presave stamps the block from what it witnessed,
 * and the session's sidecar comes back as Drupal's answer rather than as
 * anything a client put there.
 */
/** The account's own entry in a block's contributor list, if it has one. */
function credited(block: PageBlock | undefined, uid: number) {
  return block?.contributors?.find(c => c.uid === uid)
}

describe('collaboration block provenance', () => {
  let cookie: string
  const sessions: Session[] = []

  // The suite authenticates as admin, so that is the account the collab
  // server binds to the socket and the one Drupal witnesses on the write.
  const ADMIN_UID = 1

  async function open(docName: string): Promise<Session> {
    const session = await connect(cookie, docName)
    sessions.push(session)
    return session
  }

  beforeAll(async () => {
    cookie = await drupalAdminCookie()
  })

  afterEach(() => {
    for (const { provider, socket } of sessions.splice(0)) {
      provider.destroy()
      socket.destroy()
    }
  })

  /**
   * Resolves once `predicate` holds for the doc's sidecar, read as plain JSON.
   * The sidecar is a flat map of per-block, per-contributor keys, so the
   * assertions work on the reassembled shape rather than raw map entries.
   */
  function waitForBlockMeta<T>(
    doc: Y.Doc,
    predicate: (meta: BlockMetaMap) => T | undefined,
    timeoutMs = 15_000,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const map = blockMetaRoot(doc)
      const check = (): void => {
        const hit = predicate(readBlockMeta(doc))
        if (hit !== undefined) { map.unobserveDeep(check); resolve(hit) }
      }
      map.observeDeep(check)
      check()
      setTimeout(() => reject(new Error(`blockMeta condition not met within ${timeoutMs}ms`)), timeoutMs)
    })
  }

  /**
   * The regression: `blockMeta` had exactly ONE writer in the whole server tree
   * — `writeBlockMeta`, reached only from `seedBlockMeta`, which copies
   * Drupal's stored field at load and after each checkpoint. No review flag
   * ever reached a live session, so a mark could not appear until a checkpoint
   * had been to Drupal and back: one quiet timer plus two round trips.
   *
   * The unit suite pins the mirror itself (`collab-sidecar.test.ts`). This pins
   * the half only a live stack can answer for — that a real session, over a
   * real socket, is wired to it. What is asserted is that the mark EXISTS
   * without a checkpoint, never how fast it arrives: the throttle is a tunable
   * and a wall-clock assertion would only ever flake.
   */
  it('marks an edit in the live session before anything reaches Drupal', { timeout: 90_000 }, async () => {
    const probe = await createPage(
      cookie,
      '# Live mark probe\n\nUntouched block. {#b-keep}\n\nEdited block. {#b-edit}\n',
    )
    const docName = `node:${probe.nid}`
    try {
      const seeded = await storedBlockMeta(cookie, probe.uuid)
      const peer = await open(docName)
      seedBlocks(peer.doc, [
        { id: 'b-keep', text: 'Untouched block.' },
        { id: 'b-edit', text: 'Edited block.' },
      ])
      await flushed(peer)
      const changedBefore = Number(peer.doc.getMap('_meta').get('drupal_changed') ?? 0)

      typeInto(peer.doc, 'b-edit', ' With more words in it.')

      // `estimated` is a key Drupal never writes, so a flag carrying it is
      // proof the live mirror put it there rather than a re-read of storage.
      // Well under the CI quiet threshold: needing a checkpoint is the failure.
      const live = await waitForBlockMeta(
        peer.doc,
        meta => meta['b-edit']?.['pending:peer']?.estimated ? meta['b-edit'] : undefined,
        10_000,
      )

      // And nothing has been written to Drupal while that happened.
      expect(await storedBlockMeta(cookie, probe.uuid)).toEqual(seeded)
      expect(Number(peer.doc.getMap('_meta').get('drupal_changed') ?? 0)).toBe(changedBefore)

      // The baseline is the account this server watched typing, so four-eyes
      // reads the same answer off the estimate as off Drupal's own flag — and
      // a block nobody touched gets no mark at all.
      expect(contributorsSince(live, 'peer')).toContain(ADMIN_UID)
      expect(mayApprove(live, 'peer', { uid: ADMIN_UID + 1, isAdmin: false })).toBe(true)
      expect(mayApprove(live, 'peer', { uid: ADMIN_UID, isAdmin: false })).toBe(false)
      expect(readBlockMeta(peer.doc)['b-keep']?.['pending:peer']?.estimated).toBeUndefined()

      // A checkpoint puts Drupal's own answer in its place, and it reads the same.
      expect(await commitNow(cookie, probe.nid)).toMatchObject({ committed: true })
      const witnessed = await waitForBlockMeta(peer.doc, meta =>
        isPending(meta['b-edit'], 'peer') && !meta['b-edit']?.['pending:peer']?.estimated
          ? meta['b-edit']
          : undefined)
      expect(mayApprove(witnessed, 'peer', { uid: ADMIN_UID + 1, isAdmin: false })).toBe(true)
      expect(mayApprove(witnessed, 'peer', { uid: ADMIN_UID, isAdmin: false })).toBe(false)
    }
    finally {
      await deletePage(cookie, probe.uuid)
    }
  })

  it('credits the typing peer from the ops it applied, and takes Drupal\'s answer back', { timeout: 90_000 }, async () => {
    const probe = await createPage(
      cookie,
      '# Attribution probe\n\nUntouched block. {#b-keep}\n\nEdited block. {#b-edit}\n',
    )
    const docName = `node:${probe.nid}`
    try {
      // What creating the page already put on record: every block of a new
      // page is a change, so both carry a stamp before this test types
      // anything. The untouched one must come out of the edit exactly as it
      // goes in.
      const seeded = await storedBlockMeta(cookie, probe.uuid)

      const peer = await open(docName)
      expect(Number(peer.doc.getMap('_meta').get('drupal_changed') ?? 0)).toBeGreaterThan(0)

      // Typing: an ordinary Y update on the authenticated socket. Nothing about
      // authorship is sent — the server derives it from the connection.
      // Hydration, as the browser editor does it on open: the fragment is
      // filled from the same markdown Drupal holds. This must credit NOBODY —
      // it is not writing, it is arriving.
      seedBlocks(peer.doc, [
        { id: 'b-keep', text: 'Untouched block.' },
        { id: 'b-edit', text: 'Edited block.' },
      ])
      // And now the typing, into a block that is already there.
      const typed = ' With more words in it.'
      typeInto(peer.doc, 'b-edit', typed)

      // The mark moves before any commit does: the server mirrors the review
      // its own accounting has earned, ahead of the checkpoint that makes it
      // durable, and says so — `estimated` is a key Drupal never writes. Who
      // wrote the block stays Drupal's to witness, asserted off storage below.
      const live = await waitForBlockMeta(peer.doc, meta =>
        meta['b-edit']?.['pending:peer']?.estimated ? meta['b-edit'] : undefined)
      expect(contributorsSince(live, 'peer')).toContain(ADMIN_UID)

      expect(await commitNow(cookie, probe.nid)).toMatchObject({ committed: true })

      // Drupal's own witness of the same write: the edited block names the peer
      // who typed and is flagged, the untouched one is neither.
      //
      // A Save is a checkpoint the collaboration server carries, so it states
      // the window (ADR 0001) and Drupal records membership from the set — the
      // same shape every other checkpoint produces. The record is who, not how
      // much: nothing stored carries amounts (ADR 0002), so the entry for a
      // peer already on the block is its last-edit time moving, not a total
      // growing.
      const persisted = await storedBlockMeta(cookie, probe.uuid)
      expect(credited(persisted['b-edit'], ADMIN_UID)).toMatchObject({ uid: ADMIN_UID, via: null })
      expect(contributorsSince(persisted['b-edit'], 'peer')).toEqual([ADMIN_UID])
      expect(isPending(persisted['b-edit'], 'peer')).toBe(true)
      expect(persisted['b-edit']!.contributors!.map(c => c.uid)).toEqual([ADMIN_UID])
      expect(credited(persisted['b-edit'], ADMIN_UID)!.lastEdit)
        .toBeGreaterThanOrEqual(credited(seeded['b-edit'], ADMIN_UID)!.lastEdit)
      expect(persisted['b-keep']).toEqual(seeded['b-keep'])

      // And the session ends up holding exactly that, flags included — the
      // estimate replaced by the witnessed answer it was standing in for.
      const mirrored = await waitForBlockMeta(peer.doc, meta =>
        isPending(meta['b-edit'], 'peer') && !meta['b-edit']?.['pending:peer']?.estimated
          ? meta['b-edit']
          : undefined)
      expect(credited(mirrored, ADMIN_UID)).toMatchObject({ uid: ADMIN_UID, via: null })
    }
    finally {
      await deletePage(cookie, probe.uuid)
    }
  })

  it('lets no client write a sign-off, and flags the change anyway', { timeout: 90_000 }, async () => {
    const probe = await createPage(cookie, '# Review probe\n\nReviewed block. {#b-rev}\n')
    const docName = `node:${probe.nid}`
    try {
      const peer = await open(docName)
      expect(Number(peer.doc.getMap('_meta').get('drupal_changed') ?? 0)).toBeGreaterThan(0)

      // Hydration first, then the amendment as an edit of its own: seeding
      // amended text would be a no-op on a document the server restored, and
      // the commit below would have nothing to write (see seedBlocks).
      seedBlocks(peer.doc, [{ id: 'b-rev', text: 'Reviewed block.' }])
      await flushed(peer)
      typeInto(peer.doc, 'b-rev', ' Amended.')
      // A forged sign-off, written straight into the sidecar the commit
      // carries — the exact payload the gate would be defenceless against if
      // Drupal took any of it on trust.
      peer.doc.transact(() => {
        blockMetaRoot(peer.doc).set(fieldKey('b-rev', 'review:peer'), {
          uid: 202, name: 'bob', at: Date.now(), vid: 1,
        })
      })

      await flushed(peer)
      expect(await commitNow(cookie, probe.nid)).toMatchObject({ committed: true })

      const persisted = await storedBlockMeta(cookie, probe.uuid)
      expect(persisted['b-rev']!['review:peer']).toBeUndefined()
      expect(isPending(persisted['b-rev'], 'peer')).toBe(true)
    }
    finally {
      await deletePage(cookie, probe.uuid)
    }
  })
})

/**
 * Two accounts on one document — the shape a peer review actually has.
 *
 * Everything above this authenticates as admin, so every attribution
 * assertion in the suite is about one connection: a peer typing, and Drupal
 * witnessing that same peer's write. What nothing covered is two peers with
 * pending contributions at the same moment, which is the case the settle
 * exists for — each connection's tally has to reach Drupal whole, and the
 * eviction that follows the last disconnect must not run before it has.
 *
 * The second account is an ordinary signed-in user on the probe space's editor
 * roster: the non-admin reviewer, driving its own websocket.
 */
describe('collaboration multi-peer settle', () => {
  let cookie: string
  const sessions: Session[] = []

  const ADMIN_UID = 1
  const PASS = 'okb121-settle-pass'

  beforeAll(async () => {
    cookie = await drupalAdminCookie()
  })

  afterEach(() => {
    for (const { provider, socket } of sessions.splice(0)) {
      provider.destroy()
      socket.destroy()
    }
  })

  async function open(cookieOf: string, docName: string): Promise<Session> {
    const session = await connect(cookieOf, docName)
    sessions.push(session)
    return session
  }

  /** Ends one peer's session the way closing the tab does. */
  function leave(session: Session): void {
    const index = sessions.indexOf(session)
    if (index >= 0) sessions.splice(index, 1)
    session.provider.destroy()
    session.socket.destroy()
  }

  async function login(name: string): Promise<string> {
    const res = await fetch(`${DRUPAL_URL}/user/login`, {
      method: 'POST',
      body: new URLSearchParams({ name, pass: PASS, form_id: 'user_login_form', op: 'Log in' }),
      redirect: 'manual',
    })
    const session = res.headers.getSetCookie().map(c => c.split(';')[0]).find(c => /^S?SESS/.test(c))
    if (!session) throw new Error(`login failed for ${name} (status ${res.status})`)
    return session
  }

  /**
   * A second signed-in editor, with a seat on the probe space's editor roster —
   * signing in alone does not reach into a space.
   */
  async function createEditorPeer(): Promise<{ uuid: string, uid: number, cookie: string, release: () => Promise<void> }> {
    const name = `okb121-settle-${Date.now()}`
    const created = await jsonApi<{ data: { id: string, attributes: { drupal_internal__uid: number } } }>(
      cookie,
      '/jsonapi/user/user',
      {
        method: 'POST',
        body: JSON.stringify({
          data: {
            type: 'user--user',
            attributes: { name, mail: `${name}@example.com`, status: true, pass: { value: PASS } },
          },
        }),
      },
    )

    const space = await probeSpace(cookie)
    const rosterPath = `/jsonapi/openkb_space/openkb_space/${space}/relationships/members`
    const before = await jsonApi<{ data: Array<{ type: string, id: string }> | null }>(cookie, rosterPath)
    const roster = (before.data ?? []).map(d => ({ type: d.type, id: d.id }))
    await jsonApi(cookie, rosterPath, {
      method: 'PATCH',
      body: JSON.stringify({ data: [...roster, { type: 'user--user', id: created.data.id }] }),
    })

    return {
      uuid: created.data.id,
      uid: created.data.attributes.drupal_internal__uid,
      cookie: await login(name),
      /**
       * The roster entry and the account, undone together.
       *
       * Every caller takes this out in a `finally` that starts on the line
       * after the peer exists — anything created before that guard leaks on a
       * failure, and a leaked roster entry is not this suite's problem alone:
       * the space roster is a read surface other specs assert on whole.
       */
      release: async () => {
        await jsonApi(cookie, rosterPath, { method: 'PATCH', body: JSON.stringify({ data: roster }) })
        await jsonApi(cookie, `/jsonapi/user/user/${created.data.id}`, { method: 'DELETE' })
      },
    }
  }

  /**
   * Drupal's stored sidecar once the settle has landed in it — or as it stands
   * when the wait runs out.
   *
   * The gate is the sidecar's own content, because that is the thing under
   * test. `changed` is not: it advances on the checkpoint's PATCH, which is the
   * same write that stamps the sidecar — so it says nothing about whether the
   * flags, the tallies and the baselines this asks for are in it.
   *
   * It returns rather than throws on a timeout, so the verdict stays with the
   * assertions below it. A gate that fails the test itself reports "condition
   * not met in 20000ms" and takes the values that would have said which half
   * of the settle went missing with it.
   */
  async function settledBlockMeta(
    uuid: string,
    landed: (meta: Record<string, PageBlock>) => boolean,
    timeoutMs = 60_000,
  ): Promise<Record<string, PageBlock>> {
    const deadline = Date.now() + timeoutMs
    let meta = await storedBlockMeta(cookie, uuid)
    while (!landed(meta) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 250))
      meta = await storedBlockMeta(cookie, uuid)
    }
    return meta
  }

  /**
   * The live sidecar once it satisfies `predicate`.
   *
   * A timeout reports the sidecar it was watching, not just the deadline. What
   * these gates are about is *which account got credited how much*, and "not
   * met" on its own cannot tell a credit that never arrived from one booked to
   * the wrong peer — the two have opposite diagnoses and the same message.
   */
  function waitForBlockMeta<T>(what: string, doc: Y.Doc, predicate: (meta: BlockMetaMap) => T | undefined, timeoutMs = 20_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const map = blockMetaRoot(doc)
      const done = (settle: () => void): void => {
        map.unobserveDeep(check)
        clearTimeout(timer)
        settle()
      }
      const check = (): void => {
        const hit = predicate(readBlockMeta(doc))
        if (hit !== undefined) done(() => resolve(hit))
      }
      const timer = setTimeout(() => done(() => reject(new Error(
        `${what}: not met within ${timeoutMs}ms — the live sidecar held ${JSON.stringify(readBlockMeta(doc))}`,
      ))), timeoutMs)
      map.observeDeep(check)
      check()
    })
  }

  it('leaves a duplicated id on the block that already wore it', { timeout: 120_000 }, async () => {
    // Block ids come off the client, and a modified one can put a block wearing
    // somebody else's id BEFORE theirs — first in document order, which is the
    // client's to choose. Whatever reaches Drupal under that id inherits the
    // tally, the comments and the sign-offs keyed on it, so being first must buy
    // the newcomer none of them.
    const foe = await createEditorPeer()
    try {
      const probe = await createPage(cookie, '# Duplicate probe\n\nVictim block. {#b-v}\n')
      const docName = `node:${probe.nid}`
      try {
        const victim = await open(cookie, docName)
        seedBlocks(victim.doc, [{ id: 'b-v', text: 'Victim block.' }])
        // Hydration lands on its own, so the ledger has taken it as a starting
        // point before the typing arrives and measures the typing as growth.
        await flushed(victim)
        typeInto(victim.doc, 'b-v', ' Written by its owner.')
        await flushed(victim)

        // What the attack has to be aimed at is a block the server has already
        // MEASURED, and holding the bytes is not the same as having measured
        // them: incumbency resolves a duplicate against the last accounting
        // pass, so a pass that has not run yet leaves the victim's block
        // described by text it no longer holds and hands the id to document
        // order. The attacker's own first op is a writer boundary, which pays
        // the victim before those bytes land — the flush above is what makes
        // the victim's typing the thing that pass measures.
        await waitForBlockMeta(
          'the victim\'s block never reached the live sidecar',
          victim.doc,
          meta => credited(meta['b-v'], ADMIN_UID) ? meta['b-v'] : undefined,
        )

        const attacker = await open(foe.cookie, docName)
        attacker.doc.transact(() => {
          const fragment = attacker.doc.getXmlFragment('default')
          const forged = new Y.XmlElement('paragraph')
          forged.setAttribute('id', 'b-v')
          forged.insert(0, [new Y.XmlText('Not the block this id names.')])
          fragment.insert(0, [forged])
        })
        await flushed(attacker)
        expect(await commitNow(cookie, probe.nid)).toMatchObject({ committed: true })

        // Which TEXT reached Drupal under which id is the whole of it.
        const body = await storedBody(cookie, probe.uuid)
        expect(body).toContain('Victim block. Written by its owner. {#b-v}')
        expect(body).toContain('Not the block this id names. {#b-v-2}')

        const persisted = await storedBlockMeta(cookie, probe.uuid)
        // The id stayed on the block that already wore it, membership and all —
        // and the account that forged the duplicate reached neither.
        expect(credited(persisted['b-v'], ADMIN_UID)).toBeDefined()
        expect(credited(persisted['b-v'], foe.uid)).toBeUndefined()
        // The block the other account introduced landed under an id of its own,
        // in review, and named for NOBODY. The checkpoint states its window per
        // block id, and the window knows this text under the id it was forged
        // with — not the one Drupal minted for it. A changed block the window
        // does not name is unaccounted (ADR 0004): approvable by nobody until
        // an identified edit re-stamps it. Being first in document order buys
        // the newcomer no record, no comments and no sign-offs, and it does not
        // put the forger on the block either.
        expect(persisted['b-v-2']).toBeDefined()
        expect(persisted['b-v-2']!.contributors ?? []).toEqual([])
        expect(contributorsSince(persisted['b-v-2'], 'peer')).toEqual([])
        expect(credited(persisted['b-v-2'], foe.uid)).toBeUndefined()
        expect(isPending(persisted['b-v-2'], 'peer')).toBe(true)
      }
      finally {
        await deletePage(cookie, probe.uuid)
      }
    }
    finally {
      await foe.release()
    }
  })

  it('carries both peers\' contributions into Drupal when the session ends', { timeout: 120_000 }, async () => {
    const peerB = await createEditorPeer()
    try {
      const probe = await createPage(
        cookie,
        '# Settle probe\n\nAdmin block. {#b-admin}\n\nEditor block. {#b-editor}\n',
      )
      const docName = `node:${probe.nid}`

      try {
        // Creating the page already credited its author for every block; the
        // assertions below are about what this session adds on top.
        const seeded = await storedBlockMeta(cookie, probe.uuid)

        const admin = await open(cookie, docName)
        const baseline = Number(admin.doc.getMap('_meta').get('drupal_changed') ?? 0)
        expect(baseline).toBeGreaterThan(0)

        // Hydration, once, from the peer that opened first — as a browser does.
        seedBlocks(admin.doc, [
          { id: 'b-admin', text: 'Admin block.' },
          { id: 'b-editor', text: 'Editor block.' },
        ])

        // The reviewer joins the live session on their own socket. Reaching the
        // document at all is what the space roster buys them.
        const editor = await open(peerB.cookie, docName)
        await waitForBlockMeta('reviewer\'s socket never saw the seeded blockMeta', editor.doc, meta => meta['b-editor'] ? true : undefined)

        // Each types into their own block, in strict turns: the fan-out of one
        // burst reaching the other peer is the writer boundary that books it,
        // so the two tallies are separable. Credit shows in the persisted
        // sidecar after the settle — nothing mirrors it live.
        typeInto(admin.doc, 'b-admin', ' Written by the author.')
        await waitForText(editor.doc, 'Written by the author.')
        typeInto(editor.doc, 'b-editor', ' Written by the reviewer.')
        await waitForText(admin.doc, 'Written by the reviewer.')

        // Both leave. The last disconnect checkpoints, and the settle it carries
        // has to finish before the document is evicted — otherwise whichever
        // peer's contribution was still pending is simply gone.
        leave(editor)
        leave(admin)

        // Both writer sets reached Drupal: the reviewer's membership of the
        // block they typed survived the disconnect that ended the session, and
        // so did the author's. What reaches Drupal is the set — a checkpoint
        // states {uid, via} per block and no amount, and nothing stored carries
        // one either (ADR 0002). The settle has landed once the reviewer is on
        // their block.
        const persisted = await settledBlockMeta(probe.uuid, meta =>
          credited(meta['b-editor'], peerB.uid) !== undefined
          && contributorsSince(meta['b-editor'], 'peer').includes(peerB.uid))
        expect(credited(persisted['b-editor'], peerB.uid)).toMatchObject({ uid: peerB.uid, via: null })
        expect(credited(persisted['b-admin'], ADMIN_UID)).toBeDefined()
        expect(isPending(persisted['b-editor'], 'peer')).toBe(true)

        // The mirror image of the live check, and the whole point of the
        // checkpoint crediting per connection: the reviewer typed in `b-editor`
        // only, so Drupal must not have them in `b-admin` — and the author,
        // whose block it is, must not appear in `b-editor`. Right blocks, right
        // peers. Credit the carrier for the burst and both halves fail: one peer
        // wears another's paragraph, and the peer it was taken from becomes an
        // eligible approver of their own writing. The author's own seeded entry
        // on `b-editor` stands — this session did not touch that block for them.
        expect(credited(persisted['b-admin'], peerB.uid)).toBeUndefined()
        expect(credited(persisted['b-editor'], ADMIN_UID)?.lastEdit)
          .toBe(credited(seeded['b-editor'], ADMIN_UID)?.lastEdit)

        // The four-eyes baseline came out of the same write. It is the half that
        // decides who may sign the block off, and it names the reviewer on their
        // own block and nowhere else — no second request, nothing that could
        // have failed on its own and left the episode open to its own author.
        expect(contributorsSince(persisted['b-editor'], 'peer')).toContain(peerB.uid)
        expect(contributorsSince(persisted['b-admin'], 'peer')).not.toContain(peerB.uid)
        expect(contributorsSince(persisted['b-admin'], 'peer')).toContain(ADMIN_UID)

        // And the revision is a human's — the one who wrote most of this window,
        // not whichever peer's cookie carried the save. The reviewer's burst is
        // the longer of the two (' Written by the reviewer.' over ' Written by
        // the author.'), and the author is elected from the per-uid session
        // totals, so the window is filed under the reviewer whatever carrier
        // the last disconnect happened to use.
        expect(await revisionAuthorUid(cookie, probe.uuid)).toBe(peerB.uid)
      }
      finally {
        await deletePage(cookie, probe.uuid)
      }
    }
    finally {
      await peerB.release()
    }
  })

  it('opens a deletion\'s episode with the peer who made it', { timeout: 120_000 }, async () => {
    // The edit that grows nothing. The session measures characters, so a
    // deletion books no credit — and an episode opened with nobody in its
    // four-eyes baseline is one its own author may sign off. The block is
    // named on the checkpoint whether or not there is anything to credit.
    const peerB = await createEditorPeer()
    try {
      const probe = await createPage(
        cookie,
        '# Deletion probe\n\nA paragraph with a tail to remove. {#b-trim}\n',
      )
      const docName = `node:${probe.nid}`

      try {
        // Created by admin, so the block starts out as admin's episode.
        const seeded = await storedBlockMeta(cookie, probe.uuid)
        expect(contributorsSince(seeded['b-trim'], 'peer')).toEqual([ADMIN_UID])

        const editor = await open(peerB.cookie, docName)
        seedBlocks(editor.doc, [{ id: 'b-trim', text: 'A paragraph with a tail to remove.' }])
        // The fill has to reach the server as its own update before the
        // deletion does. Coalesced into one, the server takes its baseline from
        // the already-trimmed text and there is no edit left to see — which is
        // the hydration rule working, not the case under test.
        await new Promise(r => setTimeout(r, 1_500))
        deleteFrom(editor.doc, 'b-trim', ' to remove.'.length)
        leave(editor)

        const persisted = await settledBlockMeta(probe.uuid, meta =>
          contributorsSince(meta['b-trim'], 'peer').includes(peerB.uid))

        // Named: a deletion is writing, and it is not an anonymous one.
        expect(contributorsSince(persisted['b-trim'], 'peer')).toContain(peerB.uid)
        expect(credited(persisted['b-trim'], peerB.uid)).toBeDefined()
      }
      finally {
        await deletePage(cookie, probe.uuid)
      }
    }
    finally {
      await peerB.release()
    }
  })
})
