import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  connect,
  resetMocks,
  drupalMock,
  drupalToolsMock,
  toolManifestMock,
  hocuspocusMock,
  kbReadMock,
  sessionRouterMock,
  routeAgentEdit,
} from '../mcp-server.test-harness'

/**
 * commentOnBlock, driven through a real MCP client.
 *
 * What the tool decides is what reaches the session router as ops and what a
 * caller may ask for at all; who the message is *written as* is the session's
 * (server/utils/agent-peer.ts, `applyComment`), and is asserted there against
 * a real document.
 */

vi.mock('../kb-read', () => kbReadMock)
vi.mock('../drupal', () => drupalMock)
vi.mock('../session-router', importOriginal => sessionRouterMock(importOriginal))
vi.mock('../hocuspocus', () => hocuspocusMock)
vi.mock('../drupal-tools', () => drupalToolsMock)
vi.mock('../tool-manifest', () => toolManifestMock)

const POSTED = {
  nid: 7,
  entry: 'joined',
  observers: 1,
  applied: { fields: [], blocks: {}, unchanged: [], removed: [], comment: { threadId: 'c-1a2b', msgId: 'm-3c4d' } },
}

describe('commentOnBlock', () => {
  beforeEach(resetMocks)

  it('answers where the message landed, so the next reply needs no read', async () => {
    routeAgentEdit.mockResolvedValue(POSTED)
    const { client } = await connect()
    await client.listTools()

    const opened = await client.callTool({
      name: 'commentOnBlock',
      arguments: { path: 'intro', block: 'b-1', text: 'Rewrote the second sentence.' },
    })

    expect(opened.isError).toBeFalsy()
    expect((opened.structuredContent as any).applied.comment)
      .toEqual({ threadId: 'c-1a2b', msgId: 'm-3c4d' })
    expect(routeAgentEdit).toHaveBeenLastCalledWith(
      expect.anything(), expect.anything(), { nid: 7, name: 'intro' },
      { comment: { blockId: 'b-1', text: 'Rewrote the second sentence.' } },
    )

    await client.callTool({
      name: 'commentOnBlock',
      arguments: { path: 'intro', block: 'b-1', threadId: 'c-1a2b', text: 'And the units.' },
    })

    expect(routeAgentEdit).toHaveBeenLastCalledWith(
      expect.anything(), expect.anything(), expect.anything(),
      { comment: { blockId: 'b-1', text: 'And the units.', threadId: 'c-1a2b' } },
    )
  })

  it('passes a quote, its occurrence and a resolve on to the session', async () => {
    routeAgentEdit.mockResolvedValue(POSTED)
    const { client } = await connect()
    await client.listTools()

    await client.callTool({
      name: 'commentOnBlock',
      arguments: { path: 'intro', block: 'b-1', text: 'Which fish?', quote: 'fish', occurrence: 2 },
    })
    expect(routeAgentEdit).toHaveBeenLastCalledWith(
      expect.anything(), expect.anything(), expect.anything(),
      { comment: { blockId: 'b-1', text: 'Which fish?', quote: 'fish', occurrence: 2 } },
    )

    // Resolving needs no text.
    await client.callTool({
      name: 'commentOnBlock',
      arguments: { path: 'intro', block: 'b-1', threadId: 'c-1a2b', resolve: true },
    })
    expect(routeAgentEdit).toHaveBeenLastCalledWith(
      expect.anything(), expect.anything(), expect.anything(),
      { comment: { blockId: 'b-1', threadId: 'c-1a2b', resolve: true } },
    )
  })

  it('refuses a resolve without a thread, and an occurrence without a quote', async () => {
    const { client } = await connect()
    await client.listTools()

    const unnamed = await client.callTool({
      name: 'commentOnBlock',
      arguments: { path: 'intro', block: 'b-1', text: 'Fixed.', resolve: true },
    })
    expect(unnamed.isError).toBe(true)
    expect((unnamed.content as any)[0].text).toContain('threadId')

    const counted = await client.callTool({
      name: 'commentOnBlock',
      arguments: { path: 'intro', block: 'b-1', text: 'Fixed.', occurrence: 2 },
    })
    expect(counted.isError).toBe(true)
    expect(routeAgentEdit).not.toHaveBeenCalled()
  })

  it('refuses an occurrence that is not a whole number from 1, and a resolve that is not a boolean', async () => {
    const { client } = await connect()
    await client.listTools()
    const wrong = [
      { occurrence: '2' },
      { occurrence: 0 },
      { occurrence: -1 },
      { occurrence: 1.5 },
      { threadId: 'c-1', resolve: 'true' },
    ]

    for (const extra of wrong) {
      const res = await client.callTool({
        name: 'commentOnBlock',
        arguments: { path: 'intro', block: 'b-1', text: 'Fixed.', quote: 'Fixed', ...extra },
      })
      expect(res.isError, JSON.stringify(extra)).toBe(true)
    }
    expect(routeAgentEdit).not.toHaveBeenCalled()
  })

  it('checks a resolve\'s type before asking for text, and refuses a blank quote', async () => {
    const { client } = await connect()
    await client.listTools()

    for (const resolve of ['true', 1]) {
      const res = await client.callTool({
        name: 'commentOnBlock',
        arguments: { path: 'intro', block: 'b-1', threadId: 'c-1', resolve },
      })
      expect((res.content as any)[0].text).toContain('"resolve" must be true or false')
    }
    const blank = await client.callTool({
      name: 'commentOnBlock',
      arguments: { path: 'intro', block: 'b-1', text: 'Fixed.', quote: ' ' },
    })
    expect((blank.content as any)[0].text).toContain('"quote" must be a non-empty string')
    expect(routeAgentEdit).not.toHaveBeenCalled()
  })

  it('reports a resolve the session refused as a refusal', async () => {
    const { CommentRefusedError } = await import('../agent-peer')
    routeAgentEdit.mockRejectedValue(new CommentRefusedError('Thread "c-1" was not opened by you.'))
    const { client } = await connect()
    await client.listTools()

    const res = await client.callTool({
      name: 'commentOnBlock',
      arguments: { path: 'intro', block: 'b-1', threadId: 'c-1', resolve: true },
    })

    expect(res.isError).toBe(true)
    expect((res.structuredContent as any).message).toContain('not opened by you')
  })

  it('refuses an empty message before it reaches the session', async () => {
    const { client } = await connect()
    await client.listTools()

    const res = await client.callTool({
      name: 'commentOnBlock',
      arguments: { path: 'intro', block: 'b-1', text: '   ' },
    })

    expect(res.isError).toBe(true)
    expect((res.structuredContent as any).ok).toBe(false)
    expect(routeAgentEdit).not.toHaveBeenCalled()
  })

  it('reports a block the page does not hold as a refusal, not a failed call', async () => {
    const { UnknownBlockError } = await import('../agent-peer')
    routeAgentEdit.mockRejectedValue(new UnknownBlockError('b-gone'))
    const { client } = await connect()
    await client.listTools()

    const res = await client.callTool({
      name: 'commentOnBlock',
      arguments: { path: 'intro', block: 'b-gone', text: 'Where did this go?' },
    })

    expect(res.isError).toBe(true)
    expect((res.structuredContent as any).message).toContain('b-gone')
  })
})
