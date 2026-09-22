import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  connect,
  resetMocks,
  drupalMock,
  drupalToolsMock,
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

const POSTED = {
  nid: 7,
  entry: 'joined',
  observers: 1,
  applied: { fields: [], body: false, blocks: {}, comment: { threadId: 'c-1a2b', msgId: 'm-3c4d' } },
}

describe('commentOnBlock', () => {
  beforeEach(resetMocks)

  it('answers where the message landed, so the next reply needs no read', async () => {
    routeAgentEdit.mockResolvedValue(POSTED)
    const { client } = await connect()
    await client.listTools()

    const opened = await client.callTool({
      name: 'commentOnBlock',
      arguments: { path: 'intro', blockId: 'b-1', text: 'Rewrote the second sentence.' },
    })

    expect(opened.isError).toBeFalsy()
    expect((opened.structuredContent as any).applied.comment)
      .toEqual({ threadId: 'c-1a2b', msgId: 'm-3c4d' })
    expect(routeAgentEdit).toHaveBeenLastCalledWith(
      expect.anything(), expect.anything(), { nid: 7, name: 'intro' },
      { comment: { blockId: 'b-1', text: 'Rewrote the second sentence.' } },
      undefined,
    )

    await client.callTool({
      name: 'commentOnBlock',
      arguments: { path: 'intro', blockId: 'b-1', threadId: 'c-1a2b', text: 'And the units.' },
    })

    expect(routeAgentEdit).toHaveBeenLastCalledWith(
      expect.anything(), expect.anything(), expect.anything(),
      { comment: { blockId: 'b-1', text: 'And the units.', threadId: 'c-1a2b' } },
      undefined,
    )
  })

  it('offers no way to resolve a thread', async () => {
    const { client } = await connect()
    const tool = (await client.listTools()).tools.find(t => t.name === 'commentOnBlock')!
    const input = tool.inputSchema as Record<string, any>

    expect(Object.keys(input.properties).sort()).toEqual(['blockId', 'nid', 'path', 'text', 'threadId'])
    // Closed, so "resolved: true" is refused rather than ignored — and there
    // is no second tool that takes it either.
    expect(input.additionalProperties).toBe(false)
    expect((await client.listTools()).tools.map(t => t.name)).not.toContain('resolveThread')

    const res = await client.callTool({
      name: 'commentOnBlock',
      arguments: { path: 'intro', blockId: 'b-1', text: 'Fixed.', resolved: true },
    })

    expect(res.isError).toBe(true)
    expect((res.content as any)[0].text).toContain('resolved')
    expect(routeAgentEdit).not.toHaveBeenCalled()
  })

  it('refuses an empty message before it reaches the session', async () => {
    const { client } = await connect()
    await client.listTools()

    const res = await client.callTool({
      name: 'commentOnBlock',
      arguments: { path: 'intro', blockId: 'b-1', text: '   ' },
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
      arguments: { path: 'intro', blockId: 'b-gone', text: 'Where did this go?' },
    })

    expect(res.isError).toBe(true)
    expect((res.structuredContent as any).message).toContain('b-gone')
  })
})
