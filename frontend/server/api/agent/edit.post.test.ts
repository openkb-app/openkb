import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { H3Event } from 'h3'
import { AgentJoinError, AgentOpsError } from '../../utils/session-router'
import { StaleBlockError, UnanchoredBlockError, UnchainedBlockError } from '../../utils/agent-peer'
import handler from './edit.post'

/**
 * The HTTP face of the session router: what it enforces before the router runs
 * (credentials, then payload shape), and how it maps the router's refusals.
 * The router's own decisions are covered in utils/session-router.test.ts.
 */

const findKbPageByPath = vi.fn()
vi.mock('../../utils/drupal', () => ({
  findKbPageByPath: (...a: unknown[]) => findKbPageByPath(...a),
  fetchFrontmatterSpecs: vi.fn(),
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

const readBody = vi.fn()
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('h3')>()
  return { ...actual, readBody: (...a: unknown[]) => readBody(...a) }
})

const ACTOR = { token: 'tok', uid: 7, name: 'fago', via: 'Claude' }

const APPLIED = {
  nid: 7,
  entry: 'started' as const,
  observers: 0,
  applied: { fields: [], body: true },
}

function event(headers: Record<string, string> = {}): H3Event {
  return { context: {}, node: { req: { headers } } } as unknown as H3Event
}

const bearer = { authorization: 'Bearer tok' }

describe('POST /api/agent/edit', () => {
  beforeEach(() => {
    findKbPageByPath.mockReset().mockResolvedValue({ id: 'n-1', nid: 7, path: 'intro' })
    authenticateWriter.mockReset().mockResolvedValue(ACTOR)
    routeAgentEdit.mockReset().mockResolvedValue(APPLIED)
    readBody.mockReset().mockResolvedValue({ nid: 7, body: 'text' })
  })

  it('401s with no token, before the body is looked at', async () => {
    await expect(handler(event())).rejects.toMatchObject({ statusCode: 401 })
    expect(readBody).not.toHaveBeenCalled()
  })

  it('401s on a rejected token even when the payload is malformed', async () => {
    // The ordering that matters: bad credentials are the caller's real
    // problem, and an unauthenticated caller learns nothing about the shape.
    authenticateWriter.mockRejectedValue(new AgentJoinError('unauthenticated', 'The credentials were rejected.'))
    readBody.mockResolvedValue({ fields: 'not-an-object' })
    await expect(handler(event({ authorization: 'Bearer bad' })))
      .rejects.toMatchObject({ statusCode: 401, data: { denial: 'unauthenticated' } })
    expect(routeAgentEdit).not.toHaveBeenCalled()
  })

  it('403s a token below the write ceiling, also before the payload', async () => {
    authenticateWriter.mockRejectedValue(new AgentJoinError('scope', 'The "agent_write" scope is required to edit.'))
    readBody.mockResolvedValue({})
    await expect(handler(event(bearer)))
      .rejects.toMatchObject({ statusCode: 403, data: { denial: 'scope' } })
  })

  it('400s a malformed payload once the token is good', async () => {
    readBody.mockResolvedValue({ nid: 7, fields: 'not-an-object' })
    await expect(handler(event(bearer))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('400s when there is nothing to apply', async () => {
    readBody.mockResolvedValue({ nid: 7 })
    await expect(handler(event(bearer))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('ignores a session cookie riding along with the Bearer', async () => {
    await handler(event({ ...bearer, cookie: 'SESS=someone-else' }))
    expect(routeAgentEdit).toHaveBeenCalledWith(
      expect.anything(), { token: 'tok' }, { nid: 7, name: expect.any(String) }, { fields: undefined, body: 'text' }, ACTOR,
    )
  })

  it('refuses a cookie-only request — this surface is Bearer-only', async () => {
    await expect(handler(event({ cookie: 'SESS=x' }))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('resolves a path target and passes the authenticated actor on', async () => {
    readBody.mockResolvedValue({ path: 'intro.md', body: 'text' })
    await expect(handler(event(bearer))).resolves.toEqual(APPLIED)
    expect(findKbPageByPath).toHaveBeenCalledWith(expect.anything(), 'intro')
    expect(routeAgentEdit).toHaveBeenCalledWith(expect.anything(), { token: 'tok' }, { nid: 7, name: expect.any(String) }, expect.anything(), ACTOR)
  })

  it('hands the session block markdown the parser reads as the sender\'s text', async () => {
    // The write surfaces share one entity boundary (ADR 0014): what arrives
    // as source is spelled the serializer's way before the parser sees it,
    // and the field values, which never meet the parser, are left alone.
    readBody.mockResolvedValue({
      nid: 7,
      fields: { summary: 'AT&T' },
      blocks: [{ id: 'b-1', markdown: 'Wiki & AI, 5 < 6, a <span> tag.' }],
    })
    await handler(event(bearer))

    expect(routeAgentEdit).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      {
        fields: { summary: 'AT&T' },
        body: undefined,
        blocks: [{ id: 'b-1', markdown: 'Wiki & AI, 5 < 6, a &lt;span> tag.' }],
      },
      ACTOR,
    )
  })

  it('maps a per-field refusal onto 422 with data.fields', async () => {
    routeAgentEdit.mockRejectedValue(new AgentOpsError({ not_a_field: ['No exposed field.'] }))
    await expect(handler(event(bearer))).rejects.toMatchObject({
      statusCode: 422,
      data: { fields: { not_a_field: ['No exposed field.'] } },
    })
  })

  it.each([
    ['an unanchored first op', new UnanchoredBlockError(0)],
    ['an op chaining after one that wrote nothing', new UnchainedBlockError(1)],
  ])('maps %s onto 400 — the caller can fix the payload', async (_name, err) => {
    routeAgentEdit.mockRejectedValue(err)
    await expect(handler(event(bearer))).rejects.toMatchObject({
      statusCode: 400,
      statusMessage: err.message,
    })
  })

  it('a conflict hands back the block as text, ready to re-apply', async () => {
    routeAgentEdit.mockRejectedValue(new StaleBlockError([{
      index: 0,
      id: 'b-1',
      expected: 'aaaaaaaaaaaa',
      version: '28de1f57b3d1',
      markdown: 'Wiki &amp; AI {#b-1}',
    }]))
    await expect(handler(event(bearer))).rejects.toMatchObject({
      statusCode: 409,
      data: { conflicts: [{ id: 'b-1', version: '28de1f57b3d1', markdown: 'Wiki & AI {#b-1}' }] },
    })
  })

  it('maps a node-access refusal onto 403', async () => {
    routeAgentEdit.mockRejectedValue(new AgentJoinError('access', 'No update access to node 7.'))
    await expect(handler(event(bearer))).rejects.toMatchObject({
      statusCode: 403,
      data: { denial: 'access' },
    })
  })
})
