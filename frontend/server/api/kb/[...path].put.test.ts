import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { H3Event } from 'h3'
import type { FieldSpec } from '../../utils/entity-fields'
import { AgentJoinError, AgentOpsError } from '../../utils/session-router'
import handler from './[...path].put'

/**
 * The draft `.md` PUT is a transport over the session router, not a writer of
 * its own: it parses the wire format, hands the ops over, and maps refusals onto
 * HTTP. That is what these tests pin — the router's own behaviour (the join
 * gate, validation, persistence) lives in utils/session-router.test.ts. Only the
 * `<space>/<slug>/draft.md` address is writable, and only under a Bearer token.
 */

const findKbPageByPath = vi.fn()
const fetchFrontmatterSpecs = vi.fn()

vi.mock('../../utils/drupal', () => ({
  findKbPageByPath: (...a: unknown[]) => findKbPageByPath(...a),
  fetchFrontmatterSpecs: (...a: unknown[]) => fetchFrontmatterSpecs(...a),
}))

const authenticateWriter = vi.fn()
const routeAgentEdit = vi.fn()
vi.mock('../../utils/session-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/session-router')>()
  return {
    ...actual,
    authenticateWriter: (...a: unknown[]) => authenticateWriter(...a),
    routeAgentEdit: (...a: unknown[]) => routeAgentEdit(...a),
  }
})
vi.mock('../../utils/hocuspocus', () => ({ useAgentRouter: () => ({}) }))

const readRawBody = vi.fn()
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('h3')>()
  return { ...actual, readRawBody: (...a: unknown[]) => readRawBody(...a) }
})

const SPECS: FieldSpec[] = [
  { key: 'type', name: 'field_type', multiple: false, reference: false },
  { key: 'summary', name: 'field_summary', multiple: false, reference: false },
  { key: 'owner', name: 'field_owner', multiple: false, reference: true, entityType: 'user', bundles: [] },
]

const ACTOR = { token: 'tok', uid: 7, name: 'fago', via: 'Claude' }

const APPLIED = {
  nid: 7,
  entry: 'started' as const,
  observers: 0,
  applied: { fields: ['type'], body: true },
}

/** The draft address for a page, as the route captures it (no leading slash). */
const DRAFT = 'team-wiki/getting-started/draft.md'

function event(path: string, headers: Record<string, string> = {}): H3Event {
  return {
    context: { params: { path } },
    node: { req: { headers } },
  } as unknown as H3Event
}

const bearer = { authorization: 'Bearer tok' }

describe('PUT /api/kb/<space>/<slug>/draft.md', () => {
  beforeEach(() => {
    findKbPageByPath.mockReset().mockResolvedValue({ id: 'n-1', nid: 7, path: '/team-wiki/getting-started', body: '' })
    fetchFrontmatterSpecs.mockReset().mockResolvedValue(SPECS)
    authenticateWriter.mockReset().mockResolvedValue(ACTOR)
    routeAgentEdit.mockReset().mockResolvedValue(APPLIED)
    readRawBody.mockReset()
  })

  it('404s a PUT to any address that is not …/draft.md', async () => {
    readRawBody.mockResolvedValue('body')
    await expect(handler(event('team-wiki/getting-started.md', bearer)))
      .rejects.toMatchObject({ statusCode: 404 })
    await expect(handler(event('team-wiki/getting-started', bearer)))
      .rejects.toMatchObject({ statusCode: 404 })
  })

  it('401s without a Bearer token', async () => {
    readRawBody.mockResolvedValue('body')
    await expect(handler(event(DRAFT))).rejects.toMatchObject({ statusCode: 401 })
    expect(authenticateWriter).not.toHaveBeenCalled()
  })

  it('authenticates before it reads the payload', async () => {
    authenticateWriter.mockRejectedValue(new AgentJoinError('unauthenticated', 'The credentials were rejected.'))
    await expect(handler(event(DRAFT, { authorization: 'Bearer bad' })))
      .rejects.toMatchObject({ statusCode: 401 })
    expect(readRawBody).not.toHaveBeenCalled()
  })

  it('404s when the page is missing', async () => {
    findKbPageByPath.mockResolvedValue(null)
    readRawBody.mockResolvedValue('---\ntype: adr\n---\n\nbody')
    await expect(handler(event('team-wiki/missing/draft.md', bearer))).rejects.toMatchObject({ statusCode: 404 })
  })

  it('rejects an unknown/unexposed key with 422 naming it', async () => {
    readRawBody.mockResolvedValue('---\ntype: adr\nsecret: leaked\n---\n\nbody')
    await expect(handler(event(DRAFT, bearer))).rejects.toMatchObject({
      statusCode: 422,
      data: { keys: ['secret'], fields: { secret: [expect.any(String)] } },
    })
    expect(routeAgentEdit).not.toHaveBeenCalled()
  })

  it('rejects a bad value shape with 422', async () => {
    readRawBody.mockResolvedValue('---\nowner: not-a-mapping\n---\n\nbody')
    await expect(handler(event(DRAFT, bearer))).rejects.toMatchObject({ statusCode: 422 })
    expect(routeAgentEdit).not.toHaveBeenCalled()
  })

  it('hands the session a body the parser reads as the sender\'s text', async () => {
    // What arrives here is source a person or a model wrote (ADR 0014): the
    // characters that would otherwise open markup are spelled the way the
    // serializer spells them, and the field values are left alone.
    readRawBody.mockResolvedValue('---\ntype: AT&T\n---\n\nWiki & AI, 5 < 6, a <span> tag.')
    await handler(event(DRAFT, bearer))

    expect(routeAgentEdit).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      {
        fields: { type: 'AT&T' },
        body: 'Wiki & AI, 5 < 6, a &lt;span> tag.',
      },
      ACTOR,
    )
  })

  it('sends frontmatter values and body through the session as one edit', async () => {
    readRawBody.mockResolvedValue('---\ntype: adr\nsummary: hello\nowner:\n  id: u-1\n  label: admin\n---\n\n# New body')
    const result = await handler(event(DRAFT, bearer)) as Record<string, unknown>

    expect(routeAgentEdit).toHaveBeenCalledWith(
      expect.anything(),
      { token: 'tok' },
      { nid: 7, name: expect.any(String) },
      {
        fields: { type: 'adr', summary: 'hello', owner: { id: 'u-1', label: 'admin' } },
        body: '# New body',
      },
      ACTOR,
    )
    expect(result).toEqual({
      path: 'team-wiki/getting-started',
      ok: true,
      entry: 'started',
      observers: 0,
      fields: { type: 'adr', summary: 'hello', owner: { id: 'u-1', label: 'admin' } },
    })
  })

  it('an unwritable value is a 422 with per-field messages, nothing written', async () => {
    routeAgentEdit.mockRejectedValue(new AgentOpsError({ field_owner: ['Referenced user "Ghost" does not exist.'] }))
    readRawBody.mockResolvedValue('---\nowner:\n  id: u-ghost\n  label: Ghost\n---\n\nbody')
    await expect(handler(event(DRAFT, bearer))).rejects.toMatchObject({
      statusCode: 422,
      data: { fields: { field_owner: ['Referenced user "Ghost" does not exist.'] } },
    })
  })

  it('writes the body with no frontmatter fetch when the block is absent', async () => {
    readRawBody.mockResolvedValue('# Just a body, no frontmatter')
    const result = await handler(event(DRAFT, bearer)) as Record<string, unknown>
    expect(fetchFrontmatterSpecs).not.toHaveBeenCalled()
    expect(routeAgentEdit).toHaveBeenCalledWith(
      expect.anything(), { token: 'tok' }, { nid: 7, name: expect.any(String) }, { body: '# Just a body, no frontmatter' }, ACTOR,
    )
    expect(result).toMatchObject({ ok: true, fields: {} })
  })

  it('ignores cookies riding along with the token', async () => {
    readRawBody.mockResolvedValue('# Agent body')
    await handler(event(DRAFT, { ...bearer, cookie: 'SESS=x' }))
    expect(routeAgentEdit).toHaveBeenCalledWith(
      expect.anything(), { token: 'tok' }, { nid: 7, name: expect.any(String) }, { body: '# Agent body' }, ACTOR,
    )
  })

  it('401s a cookie-only request — humans edit in the collaborative editor', async () => {
    readRawBody.mockResolvedValue('# Body')
    await expect(handler(event(DRAFT, { cookie: 'SESS=x' }))).rejects.toMatchObject({ statusCode: 401 })
    expect(authenticateWriter).not.toHaveBeenCalled()
  })

  it('reports what the session did with the write, not a Drupal verdict', async () => {
    routeAgentEdit.mockResolvedValue({ ...APPLIED, entry: 'joined', observers: 2 })
    readRawBody.mockResolvedValue('# Body')
    const result = await handler(event(DRAFT, bearer)) as Record<string, unknown>
    expect(result).toMatchObject({ ok: true, entry: 'joined', observers: 2 })
  })
})
