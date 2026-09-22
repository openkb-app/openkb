import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { prosemirrorJSONToYDoc, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap'
import type { JSONContent } from '@tiptap/core'
import { editorSchema } from './editor-schema'
import { collectBlockIds } from '#shared/page-blocks'
import { serializeYDoc } from './commit'
import type { CommitResult } from './commit'
import type { FieldSpec } from './entity-fields'
import { CommitValidationError } from './commit'
import {
  AGENT_WRITE_SCOPE,
  AgentJoinError,
  AgentOpsError,
  authorizeSessionWrite,
  drupalGateDeps,
  routeAgentEdit,
  type WriteRefusal,
  type AgentIdentity,
  type RouterDeps,
} from './session-router'
import { closeAgentSessions } from './agent-sessions'

const SPECS: FieldSpec[] = [
  { key: 'summary', name: 'field_summary', multiple: false, reference: false },
  { key: 'tags', name: 'field_tags', multiple: true, reference: true, entityType: 'taxonomy_term', bundles: ['topic'] },
]

const AGENT: AgentIdentity = { uid: 7, name: 'fago', via: 'Claude', scopes: ['agent_read', AGENT_WRITE_SCOPE] }

const COMMITTED: CommitResult = { outcome: 'committed', committed: true, changed: 200 }

function gate(
  identity: AgentIdentity | Error,
  canUpdate = true,
  denied: string[] | null = [],
  refusal: WriteRefusal = 'read-only',
) {
  return {
    fetchIdentity: vi.fn(async () => {
      if (identity instanceof Error) throw identity
      return identity
    }),
    checkNodeAccess: vi.fn(async () => (
      canUpdate ? { allowed: true, denied } : { allowed: false, denied: null, refusal }
    )),
  }
}

/** The page a refusal names, as the caller addressed it. */
const SUBJECT = { nid: 12, name: '/general/getting-started' }

function upstream(statusCode: number): Error {
  return Object.assign(new Error(`Request failed (${statusCode})`), { statusCode })
}

describe('authorizeAgentSession', () => {
  it('returns the acting agent when all three checks pass', async () => {
    const deps = gate(AGENT)
    await expect(authorizeSessionWrite(deps, { token: 'tok' }, SUBJECT)).resolves.toEqual({
      token: 'tok', uid: 7, name: 'fago', via: 'Claude',
    })
    expect(deps.checkNodeAccess).toHaveBeenCalledWith({ Authorization: 'Bearer tok' }, 12)
  })

  it('rejects a token Drupal refuses (invalid / expired / revoked)', async () => {
    await expect(authorizeSessionWrite(gate(upstream(401)), { token: 'bad' }, SUBJECT))
      .rejects.toMatchObject({ denial: 'unauthenticated', statusCode: 401 })
  })

  it('rejects a *token* that carries no agent scope — no `via`', async () => {
    const human: AgentIdentity = { uid: 3, name: 'fago', via: null, scopes: [] }
    await expect(authorizeSessionWrite(gate(human), { token: 'tok' }, SUBJECT))
      .rejects.toMatchObject({ denial: 'unauthenticated' })
  })

  it('refuses a tokenless request without asking Drupal anything', async () => {
    const deps = gate(AGENT)
    await expect(authorizeSessionWrite(deps, {}, SUBJECT))
      .rejects.toMatchObject({ denial: 'unauthenticated', statusCode: 401 })
    expect(deps.fetchIdentity).not.toHaveBeenCalled()
  })

  it('rejects an agent token without the write scope, naming the page and the fix', async () => {
    const readOnly: AgentIdentity = { ...AGENT, scopes: ['agent_read'] }
    await expect(authorizeSessionWrite(gate(readOnly), { token: 'tok' }, SUBJECT))
      .rejects.toMatchObject({
        denial: 'scope',
        statusCode: 403,
        // The page the caller named, and what a human can do about it. The
        // scope is the credential's, so the wording does not read as a
        // property of this page.
        message: 'These credentials cannot edit /general/getting-started: the '
          + '"agent_write" scope is missing. Whoever manages this API client can add it.',
      })
  })

  it('says what Drupal answered, in the caller\'s own name for the page', async () => {
    // Each line is a fact about this request. Nothing names a space, a roster
    // or a rule — a caller learns what happened, not who decided it.
    const refusals: Array<[WriteRefusal, string]> = [
      ['read-only', 'No write access to /general/getting-started: these credentials may read it but not change it.'],
      ['unreadable', 'These credentials cannot access /general/getting-started.'],
      ['absent', 'There is no page at /general/getting-started.'],
    ]
    for (const [refusal, message] of refusals) {
      await expect(authorizeSessionWrite(gate(AGENT, false, null, refusal), { token: 'tok' }, SUBJECT))
        .rejects.toMatchObject({ denial: 'access', statusCode: 403, message })
    }
  })

  it('tells a nid-addressed caller the nid it named, and nothing more', async () => {
    await expect(authorizeSessionWrite(gate(AGENT, false), { token: 'tok' }, { nid: 12, name: 'node 12' }))
      .rejects.toMatchObject({
        message: 'No write access to node 12: these credentials may read it but not change it.',
      })
  })

  it('rejects a token whose owner may not edit one of the session fields', async () => {
    const deps = gate(AGENT, true, ['field_owner'])
    await expect(authorizeSessionWrite(deps, { token: 'tok' }, SUBJECT))
      .rejects.toMatchObject({ denial: 'access', statusCode: 403, message: /field_owner/ })
  })

  it('refuses a join Drupal answered no field access for at all', async () => {
    const deps = gate(AGENT, true, null)
    await expect(authorizeSessionWrite(deps, { token: 'tok' }, SUBJECT))
      .rejects.toMatchObject({ denial: 'access', statusCode: 403 })
  })

  it('does not turn an unreachable Drupal into an authorization answer', async () => {
    await expect(authorizeSessionWrite(gate(upstream(503)), { token: 'tok' }, SUBJECT))
      .rejects.not.toBeInstanceOf(AgentJoinError)
  })

  it('asks Drupal every time it is called — the caching is the session\'s, not this function\'s', async () => {
    const deps = gate(AGENT)
    await authorizeSessionWrite(deps, { token: 'tok' }, SUBJECT)
    await authorizeSessionWrite(deps, { token: 'tok' }, SUBJECT)
    expect(deps.fetchIdentity).toHaveBeenCalledTimes(2)
    expect(deps.checkNodeAccess).toHaveBeenCalledTimes(2)
  })
})

/** The id the fixture document's only block carries — what a block op names. */
const SEED_BLOCK = 'b-seed'

function docWith(text: string): Y.Doc & { awareness: Awareness, getConnections: () => unknown[] } {
  const doc = prosemirrorJSONToYDoc(editorSchema, {
    type: 'doc',
    content: [{ type: 'paragraph', attrs: { id: SEED_BLOCK }, content: [{ type: 'text', text }] }],
  } as never, 'default') as Y.Doc & { awareness: Awareness, getConnections: () => unknown[] }
  doc.awareness = new Awareness(doc)
  doc.awareness.setLocalState(null)
  doc.getConnections = () => []
  return doc
}

/**
 * The seed block after the agent rewrote it.
 *
 * The id survives the rewrite: a replaced block is the same block, and the
 * sidecar keys its contributors and its review history on that id.
 */
const REWRITTEN_SEED = `after {#${SEED_BLOCK}}`

/**
 * The live dep, against the answers Drupal actually gives. Only a 403 or a 404
 * is an access answer; everything else is an outage and must reach the caller
 * as one.
 */
describe('drupalGateDeps().checkNodeAccess', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch')
  vi.stubGlobal('useRuntimeConfig', () => ({ drupalBaseUrl: 'http://drupal.test/' }))
  const answer = (status: number, body: unknown = {}) =>
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }))

  afterEach(() => fetchSpy.mockReset())

  it('reads a granted write off the join-access answer', async () => {
    answer(200, { update: true, denied_fields: [] })
    await expect(drupalGateDeps().checkNodeAccess({}, 12))
      .resolves.toMatchObject({ allowed: true })
  })

  it('reads a refused update as read-only, not as a mystery', async () => {
    answer(200, { update: false })
    await expect(drupalGateDeps().checkNodeAccess({}, 12))
      .resolves.toMatchObject({ allowed: false, refusal: 'read-only' })
  })

  it('separates a refused read from a page that is not there', async () => {
    answer(403)
    await expect(drupalGateDeps().checkNodeAccess({}, 12))
      .resolves.toMatchObject({ allowed: false, refusal: 'unreadable' })
    answer(404)
    await expect(drupalGateDeps().checkNodeAccess({}, 12))
      .resolves.toMatchObject({ allowed: false, refusal: 'absent' })
  })

  it('does not turn an outage into a denial — an agent must not abandon a page it owns', async () => {
    answer(502)
    await expect(drupalGateDeps().checkNodeAccess({}, 12))
      .rejects.toMatchObject({ statusCode: 503 })

    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(drupalGateDeps().checkNodeAccess({}, 12))
      .rejects.toMatchObject({ statusCode: 503 })
  })
})

describe('routeAgentEdit', () => {
  let doc: ReturnType<typeof docWith>
  let disconnect: ReturnType<typeof vi.fn>
  let checkpoint: ReturnType<typeof vi.fn>
  let deps: RouterDeps

  beforeEach(() => {
    doc = docWith('before')
    disconnect = vi.fn(async () => {})
    checkpoint = vi.fn(async () => COMMITTED)
    deps = {
      ...gate(AGENT),
      host: {
        documents: new Map(),
        openDirectConnection: vi.fn(async () => ({ document: doc, disconnect, transact: vi.fn() })),
      },
      fetchSpecs: vi.fn(async () => SPECS),
      validateValues: vi.fn(async () => {}),
      fetchBody: vi.fn(async () => 'from drupal'),
      captureCarrier: vi.fn(),
      checkpoint,
    } as unknown as RouterDeps
  })

  afterEach(async () => {
    // The registry is process-wide: a session left open would be handed to the
    // next test, which is exactly what it does in production.
    await closeAgentSessions({ persist: false })
  })

  it('starts a headless session and stays in it', async () => {
    const result = await routeAgentEdit(deps, { token: 'tok' }, { nid: 1, name: 'node 1' }, {
      fields: { summary: 'a summary' },
      blocks: [{ id: SEED_BLOCK, markdown: 'after' }],
    })

    expect(result.entry).toBe('started')
    expect(result.observers).toBe(0)
    expect(result.applied).toEqual({
      fields: ['summary'],
      body: false,
      blocks: { [SEED_BLOCK]: expect.stringMatching(/^[\da-f]{12}$/) },
    })
    // Authored content, so the block carries a minted id (agent-block-ids.ts).
    expect(serializeYDoc(doc)).toBe(REWRITTEN_SEED)
    expect(doc.getMap('fields').get('summary')).toBe('a summary')
    // Nothing was written to Drupal, and the peer is still in the room.
    expect(checkpoint).not.toHaveBeenCalled()
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('reuses the open session for the next write, and asks Drupal nothing', async () => {
    await routeAgentEdit(deps, { token: 'tok' }, { nid: 1, name: 'node 1' }, { blocks: [{ id: SEED_BLOCK, markdown: 'first' }] })
    ;(deps.fetchIdentity as ReturnType<typeof vi.fn>).mockClear()
    ;(deps.checkNodeAccess as ReturnType<typeof vi.fn>).mockClear()

    const second = await routeAgentEdit(deps, { token: 'tok' }, { nid: 1, name: 'node 1' }, { blocks: [{ id: SEED_BLOCK, markdown: 'second' }] })

    expect(deps.fetchIdentity).not.toHaveBeenCalled()
    expect(deps.checkNodeAccess).not.toHaveBeenCalled()
    expect(deps.host.openDirectConnection).toHaveBeenCalledOnce()
    expect(Object.keys(second.applied.blocks)).toEqual([SEED_BLOCK])
    expect(serializeYDoc(doc)).toBe(`second {#${SEED_BLOCK}}`)
  })

  it('never lets one credential onto another\'s session', async () => {
    await routeAgentEdit(deps, { token: 'tok' }, { nid: 1, name: 'node 1' }, { blocks: [{ id: SEED_BLOCK, markdown: 'first' }] })

    // Same account, same consumer, a different token — its own gate, its own
    // session. A token that lost the write scope must not inherit one.
    await routeAgentEdit(deps, { token: 'other' }, { nid: 1, name: 'node 1' }, { blocks: [{ id: SEED_BLOCK, markdown: 'second' }] })

    expect(deps.checkNodeAccess).toHaveBeenCalledTimes(2)
    expect(deps.checkNodeAccess).toHaveBeenLastCalledWith({ Authorization: 'Bearer other' }, 1)
    expect(deps.host.openDirectConnection).toHaveBeenCalledTimes(2)
  })

  it('signs each writer\'s revision with that writer — never one actor\'s name on another\'s ops', async () => {
    // A checkpoint serializes the whole document, so a document carrying two
    // credentials' uncommitted ops can only be signed by one of them. What is
    // signed is therefore handed over: the second writer checks the first one's
    // work in, under the first one, before its own ops join it.
    const identities: Record<string, AgentIdentity> = {
      'Bearer tok-a': { uid: 7, name: 'ada', via: 'Claude', scopes: [AGENT_WRITE_SCOPE] },
      'Bearer tok-b': { uid: 9, name: 'bo', via: 'Codex', scopes: [AGENT_WRITE_SCOPE] },
    }
    const signed: Array<{ user?: string, summary: unknown }> = []
    deps.fetchIdentity = vi.fn(async (auth: Record<string, string>) => identities[auth.Authorization!]!)
    deps.checkpoint = vi.fn(async (_document, _trigger, identity) => {
      signed.push({ user: identity.user, summary: doc.getMap('fields').get('summary') })
      return COMMITTED
    })

    await routeAgentEdit(deps, { token: 'tok-a' }, { nid: 1, name: 'node 1' }, { fields: { summary: 'A wrote 1.' } })
    await routeAgentEdit(deps, { token: 'tok-b' }, { nid: 1, name: 'node 1' }, { fields: { summary: 'B wrote 2.' } })
    await closeAgentSessions({})

    expect(signed).toEqual([
      { user: 'ada', summary: 'A wrote 1.' },
      { user: 'bo', summary: 'B wrote 2.' },
    ])
  })

  it('points a handed-over document\'s carrier at the writer that now owns it', async () => {
    // The document's own checkpoints — the quiet timer, the max-dirty backstop
    // — go out under its captured carrier. The handover left it clean, so what
    // they serialize from here is the new writer's work.
    deps.fetchIdentity = vi.fn(async (auth: Record<string, string>) => (
      auth.Authorization === 'Bearer tok-b' ? { ...AGENT, uid: 9, name: 'bo', via: 'Codex' } : AGENT
    ))
    await routeAgentEdit(deps, { token: 'tok-a' }, { nid: 1, name: 'node 1' }, { fields: { summary: 'a' } })
    ;(deps.host.documents as Map<string, unknown>).set('node:1', doc)

    await routeAgentEdit(deps, { token: 'tok-b' }, { nid: 1, name: 'node 1' }, { fields: { summary: 'b' } })

    expect(deps.captureCarrier)
      .toHaveBeenLastCalledWith('node:1', { token: 'tok-b', user: 'bo', via: 'Codex' })
  })

  it('refuses a write onto a session that closed while the write was validated', async () => {
    await routeAgentEdit(deps, { token: 'tok' }, { nid: 1, name: 'node 1' }, { fields: { summary: 'first' } })
    // Validation is a Drupal round-trip, and the session can lapse inside it —
    // a write applied to a session that left reaches a detached document while
    // the caller is told it landed.
    ;(deps.validateValues as ReturnType<typeof vi.fn>)
      .mockImplementation(async () => { await closeAgentSessions({ persist: false }) })

    await expect(routeAgentEdit(deps, { token: 'tok' }, { nid: 1, name: 'node 1' }, { fields: { summary: 'second' } }))
      .rejects.toMatchObject({ statusCode: 409 })
    expect(doc.getMap('fields').get('summary')).toBe('first')
  })

  it('joins a live session and leaves persistence to the humans in it', async () => {
    ;(deps.host.documents as Map<string, unknown>).set('node:1', doc)
    doc.getConnections = () => [{}, {}]

    const result = await routeAgentEdit(deps, { token: 'tok' }, { nid: 1, name: 'node 1' }, { blocks: [{ id: SEED_BLOCK, markdown: 'after' }] })

    expect(result.entry).toBe('joined')
    expect(result.observers).toBe(2)
    // The edit landed in the shared document; nothing was written to Drupal,
    // which is exactly why the peers see no external-change banner.
    expect(serializeYDoc(doc)).toBe(REWRITTEN_SEED)
    expect(checkpoint).not.toHaveBeenCalled()
  })

  it('publishes the blocks it wrote as its own presence, for as long as it stays', async () => {
    await routeAgentEdit(deps, { token: 'tok' }, { nid: 1, name: 'node 1' }, { blocks: [{ id: SEED_BLOCK, markdown: 'after' }] })
    const states = [...doc.awareness.getStates().values()] as Array<{ claim?: { blocks: string[] } }>
    expect(states.filter(state => state.claim)).toEqual([
      expect.objectContaining({ claim: { blocks: [SEED_BLOCK] } }),
    ])

    // A write that names no block says nothing about where the agent is.
    await routeAgentEdit(deps, { token: 'tok' }, { nid: 1, name: 'node 1' }, { fields: { summary: 'x' } })
    const after = [...doc.awareness.getStates().values()] as Array<{ claim?: unknown }>
    expect(after.filter(state => state.claim)).toEqual([])
  })

  it('persists once, when the session lapses and nobody else will', async () => {
    await routeAgentEdit(deps, { token: 'tok' }, { nid: 1, name: 'node 1' }, { blocks: [{ id: SEED_BLOCK, markdown: 'after' }] })
    expect(checkpoint).not.toHaveBeenCalled()

    await closeAgentSessions({})

    expect(checkpoint).toHaveBeenCalledWith('node:1', 'agent', { token: 'tok', user: 'fago', via: 'Claude' })
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('leaves a lapsing session\'s document to the humans still in it', async () => {
    ;(deps.host.documents as Map<string, unknown>).set('node:1', doc)
    doc.getConnections = () => [{}]
    await routeAgentEdit(deps, { token: 'tok' }, { nid: 1, name: 'node 1' }, { blocks: [{ id: SEED_BLOCK, markdown: 'after' }] })

    await closeAgentSessions({})

    expect(checkpoint).not.toHaveBeenCalled()
  })

  it('refuses a whole body on an existing page — it is edited block by block', async () => {
    await expect(routeAgentEdit(deps, { token: 'tok' }, { nid: 1, name: 'node 1' }, { body: 'a whole new page' }))
      .rejects.toMatchObject({ statusCode: 422 })

    expect(deps.host.openDirectConnection).not.toHaveBeenCalled()
    expect(serializeYDoc(doc)).toBe(`before {#${SEED_BLOCK}}`)
  })

  it('refuses ops the exposure contract cannot address — before joining', async () => {
    await expect(routeAgentEdit(deps, { token: 'tok' }, { nid: 1, name: 'node 1' }, { fields: { nope: 'x' } }))
      .rejects.toBeInstanceOf(AgentOpsError)
    expect(deps.host.openDirectConnection).not.toHaveBeenCalled()
  })

  it('a denied join never opens a session', async () => {
    deps = { ...deps, ...gate(AGENT, false) }
    await expect(routeAgentEdit(deps, { token: 'tok' }, { nid: 1, name: 'node 1' }, { blocks: [{ id: SEED_BLOCK, markdown: 'after' }] }))
      .rejects.toMatchObject({ denial: 'access' })
    expect(deps.host.openDirectConnection).not.toHaveBeenCalled()
    expect(serializeYDoc(doc)).toBe(`before {#${SEED_BLOCK}}`)
  })

  it('fills an empty headless body from Drupal before a fields-only write', async () => {
    // Server-side seeding leaves the fragment empty (a browser peer hydrates
    // it). Without this the commit would serialize a blank document and hand
    // Drupal an empty body — the write that erases the page.
    doc = docWith('seeded but never hydrated')
    const fragment = doc.getXmlFragment('default')
    fragment.delete(0, fragment.length)
    deps = {
      ...deps,
      host: {
        documents: new Map(),
        openDirectConnection: vi.fn(async () => ({ document: doc, disconnect, transact: vi.fn() })),
      },
    } as unknown as RouterDeps

    const result = await routeAgentEdit(deps, { token: 'tok' }, { nid: 1, name: 'node 1' }, { fields: { summary: 'only fields' } })

    expect(serializeYDoc(doc)).toBe('from drupal')
    // The body was restored, not authored — the caller is not told it wrote one.
    expect(result.applied.body).toBe(false)
  })

  it('keeps the block ids Drupal\'s body carries when it fills a headless one', async () => {
    // The seam against the block-id sweep (server/utils/commit-block-ids.ts):
    // a document that lost the ids Drupal's markdown carries would commit
    // id-less blocks, and nothing Drupal stamps could name them again.
    doc = docWith('seeded but never hydrated')
    const fragment = doc.getXmlFragment('default')
    fragment.delete(0, fragment.length)
    doc.getMap('blockMeta').set('b-1', { contributors: [{ uid: 3, via: null, lastEdit: 1 }] })
    deps = {
      ...deps,
      fetchBody: vi.fn(async () => 'kept {#b-1}\n\nsecond {#b-2}'),
      host: {
        documents: new Map(),
        openDirectConnection: vi.fn(async () => ({ document: doc, disconnect, transact: vi.fn() })),
      },
    } as unknown as RouterDeps

    await routeAgentEdit(deps, { token: 'tok' }, { nid: 1, name: 'node 1' }, { fields: { summary: 'only fields' } })

    const present = collectBlockIds(
      yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('default')) as JSONContent,
    )
    expect([...present]).toEqual(['b-1', 'b-2'])
    // Restoration, not authorship: no tally, and the bytes go back unchanged.
    expect((doc.getMap('blockMeta').get('b-1') as { contributors: unknown[] }).contributors).toHaveLength(1)
    expect(serializeYDoc(doc)).toBe('kept {#b-1}\n\nsecond {#b-2}')
  })

  it('hands a headless document its own carrier before it loads', async () => {
    // Every Drupal read the document makes runs under the carrier captured for
    // it, and on a moderated page the working copy is invisible to anonymous
    // — so a session an agent starts has to contribute the agent's token, or it
    // seeds from the published revision (or not at all) and commits the wrong
    // body back.
    await routeAgentEdit(deps, { token: 'tok' }, { nid: 1, name: 'node 1' }, { blocks: [{ id: SEED_BLOCK, markdown: 'after' }] })

    expect(deps.captureCarrier).toHaveBeenCalledWith('node:1', { token: 'tok', user: 'fago', via: 'Claude' })
  })

  it('leaves a live document\'s carrier to the humans in it', async () => {
    // Replacing it would run their next timer-driven checkpoint — and the
    // revision it writes — under this agent.
    ;(deps.host.documents as Map<string, unknown>).set('node:1', doc)
    await routeAgentEdit(deps, { token: 'tok' }, { nid: 1, name: 'node 1' }, { blocks: [{ id: SEED_BLOCK, markdown: 'after' }] })
    expect(deps.captureCarrier).not.toHaveBeenCalled()
  })

  it('never re-fills a body the writer is replacing anyway', async () => {
    await routeAgentEdit(deps, { token: 'tok' }, { nid: 1, name: 'node 1' }, { blocks: [{ id: SEED_BLOCK, markdown: 'after' }] })
    expect(deps.fetchBody).not.toHaveBeenCalled()
    expect(serializeYDoc(doc)).toBe(REWRITTEN_SEED)
  })

  it('leaves a live session\'s fragment alone', async () => {
    ;(deps.host.documents as Map<string, unknown>).set('node:1', doc)
    // An empty fragment in a live session may be a deletion its peers have not
    // committed yet; Drupal must not be allowed to undo it behind their backs.
    doc.getXmlFragment('default').delete(0, doc.getXmlFragment('default').length)
    await routeAgentEdit(deps, { token: 'tok' }, { nid: 1, name: 'node 1' }, { fields: { summary: 'x' } })
    expect(deps.fetchBody).not.toHaveBeenCalled()
    expect(serializeYDoc(doc)).toBe('')
  })

  it('refuses a value the commit could not write — before joining', async () => {
    // An unresolvable reference passes the shape check and fails the mapper.
    deps = {
      ...deps,
      validateValues: vi.fn(async () => {
        throw new CommitValidationError('Validation failed', {
          field_tags: ['Referenced taxonomy_term "ghost" does not exist.'],
        })
      }),
    }
    await expect(routeAgentEdit(deps, { token: 'tok' }, { nid: 1, name: 'node 1' }, { fields: { tags: [{ id: 'ghost', label: 'ghost' }] } }))
      .rejects.toMatchObject({ fields: { field_tags: expect.any(Array) } })
    expect(deps.host.openDirectConnection).not.toHaveBeenCalled()
    expect(doc.getMap('fields').get('tags')).toBeUndefined()
  })

  it('validates values under the carrier that will do the writing', async () => {
    await routeAgentEdit(deps, { token: 'tok' }, { nid: 1, name: 'node 1' }, { fields: { summary: 'x' } })
    expect(deps.validateValues).toHaveBeenCalledWith(SPECS, { summary: 'x' }, { Authorization: 'Bearer tok' })
  })
})
