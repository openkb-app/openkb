import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  connect,
  resetMocks,
  refusalFromTheCasCheck,
  drupalMock,
  drupalToolsMock,
  hocuspocusMock,
  kbReadMock,
  sessionRouterMock,
  getKbPage,
  routeAgentEdit,
  STALE,
} from '../mcp-server.test-harness'
import { StaleBlockError, UnanchoredBlockError, UnchainedBlockError } from '../agent-peer'

/**
 * updateBlocks, driven through a real MCP client. Listing caches the output
 * schema, which is what makes the client validate the results below — a
 * refusal is part of the contract, not prose beside it.
 */

vi.mock('../kb-read', () => kbReadMock)
vi.mock('../drupal', () => drupalMock)
vi.mock('../session-router', importOriginal => sessionRouterMock(importOriginal))
vi.mock('../hocuspocus', () => hocuspocusMock)
vi.mock('../drupal-tools', () => drupalToolsMock)

describe('updateBlocks', () => {
  beforeEach(resetMocks)

  it('updateBlocks answers the version it wrote, and the next edit chains on it', async () => {
    routeAgentEdit.mockResolvedValue({
      nid: 7,
      entry: 'started',
      observers: 0,
      applied: { fields: [], body: false, blocks: { 'b-0d53e244': '05b561c1ae22' } },
    })
    const { client } = await connect()
    await client.listTools()

    const first = await client.callTool({
      name: 'updateBlocks',
      arguments: { path: 'intro', blocks: [{ id: 'b-0d53e244', expect: 'c070666432ee', markdown: 'One.' }] },
    })
    const written = (first.structuredContent as any).applied.blocks
    expect(written).toEqual({ 'b-0d53e244': '05b561c1ae22' })

    await client.callTool({
      name: 'updateBlocks',
      arguments: { path: 'intro', blocks: [{ id: 'b-0d53e244', expect: written['b-0d53e244'], markdown: 'Two.' }] },
    })

    expect(routeAgentEdit).toHaveBeenLastCalledWith(
      expect.anything(), expect.anything(), { nid: 7, name: expect.any(String) },
      { blocks: [{ id: 'b-0d53e244', expect: '05b561c1ae22', markdown: 'Two.' }] },
      undefined,
    )
    // The whole point: two edits to one block, and no read between them.
    expect(getKbPage).not.toHaveBeenCalled()
  })

  it('names the op at fault, so a caller need not bisect its own request', async () => {
    const { client } = await connect()

    const bad = await client.callTool({
      name: 'updateBlocks',
      arguments: {
        path: 'intro',
        blocks: [
          { id: 'b-0d53e244', markdown: 'Fine.' },
          { after: 'b-0d53e244' },
          { id: 'b-0d53e244', markdown: 'Also fine.' },
        ],
      },
    })

    expect((bad.content as any[])[0].text).toContain('blocks[1]')
    expect(routeAgentEdit).not.toHaveBeenCalled()
  })

  it('refuses a misspelt key inside an op, rather than dropping it', async () => {
    const { client } = await connect()
    await client.listTools()

    // `expects` reads as a version guard and is not one: dropped silently, the
    // op would overwrite whatever the block holds now.
    const bad = await client.callTool({
      name: 'updateBlocks',
      arguments: {
        path: 'intro',
        blocks: [{ id: 'b-0d53e244', expects: 'c070666432ee', markdown: 'One.' }],
      },
    })

    expect(bad.isError).toBe(true)
    expect((bad.content as any[])[0].text).toContain('blocks[0].expects')
    expect(routeAgentEdit).not.toHaveBeenCalled()
  })

  it('takes an anchorless op that chains after the one before it', async () => {
    routeAgentEdit.mockResolvedValue({
      nid: 7,
      entry: 'started',
      observers: 0,
      applied: { fields: [], body: false, blocks: {} },
    })
    const { client } = await connect()

    const blocks = [{ after: 'b-0d53e244', markdown: 'One.' }, { markdown: 'Two.' }]
    const res = await client.callTool({ name: 'updateBlocks', arguments: { path: 'intro', blocks } })

    expect(res.isError).toBeFalsy()
    expect(routeAgentEdit).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), { nid: 7, name: expect.any(String) }, { blocks }, undefined,
    )
  })

  it('sends an anchorless first op on to the session — an empty page has nothing to name', async () => {
    routeAgentEdit.mockResolvedValue({
      nid: 7,
      entry: 'started',
      observers: 0,
      applied: { fields: [], body: false, blocks: { 'b-9f21': '05b561c1ae22' } },
    })
    const { client } = await connect()

    const blocks = [{ markdown: 'The first block of an empty page.' }]
    const res = await client.callTool({ name: 'updateBlocks', arguments: { path: 'intro', blocks } })

    expect(res.isError).toBeFalsy()
    expect(routeAgentEdit).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), { nid: 7, name: expect.any(String) }, { blocks }, undefined,
    )
  })

  it('reports the session\'s refusal of an anchorless op on a page that holds blocks', async () => {
    routeAgentEdit.mockRejectedValue(new UnanchoredBlockError(0))
    const { client } = await connect()
    await client.listTools()

    const res = await client.callTool({
      name: 'updateBlocks',
      arguments: { path: 'intro', blocks: [{ markdown: 'orphan' }] },
    })

    expect(res.isError).toBe(true)
    expect((res.content as any[])[0].text).toBe(
      'blocks[0] needs one of id / after / before — no op precedes it to chain after.',
    )
  })

  it('reports the session\'s refusal of an op chaining after one that wrote nothing', async () => {
    routeAgentEdit.mockRejectedValue(new UnchainedBlockError(1))
    const { client } = await connect()
    await client.listTools()

    const res = await client.callTool({
      name: 'updateBlocks',
      arguments: { path: 'intro', blocks: [{ id: 'b-1', markdown: '' }, { markdown: 'orphan' }] },
    })

    expect(res.isError).toBe(true)
    expect((res.content as any[])[0].text).toBe(
      'blocks[1] chains after blocks[0], which wrote no block to follow.',
    )
  })

  it('rejects a write result that reports block ids without their versions', async () => {
    routeAgentEdit.mockResolvedValue({
      nid: 7,
      entry: 'started',
      observers: 0,
      applied: { fields: [], body: false, blocks: ['b-0d53e244'] },
    })
    const { client } = await connect()
    await client.listTools()

    await expect(client.callTool({
      name: 'updateBlocks',
      arguments: { path: 'intro', blocks: [{ id: 'b-0d53e244', markdown: 'One.' }] },
    })).rejects.toThrow(/output schema/)
  })

  it('a stale write comes back as the conflicts the output schema declares', async () => {
    const refusal = await refusalFromTheCasCheck()
    routeAgentEdit.mockRejectedValue(refusal)
    const { client } = await connect()
    await client.listTools()

    const res = await client.callTool({
      name: 'updateBlocks',
      arguments: { path: 'intro', blocks: [{ id: 'b-1', expect: STALE, markdown: 'agent rewrite' }] },
    })

    expect(res.isError).toBe(true)
    expect(res.structuredContent).toEqual({
      ok: false,
      message: refusal.message,
      conflicts: [{
        index: 0,
        id: 'b-1',
        expected: STALE,
        version: expect.stringMatching(/^[\da-f]{12}$/),
        markdown: 'first {#b-1}',
      }],
    })
    // Everything the retry needs is in the payload — no second read.
    expect(getKbPage).not.toHaveBeenCalled()
  })

  it('the refusal schema is enforced: a conflict missing what a retry needs is refused', async () => {
    routeAgentEdit.mockRejectedValue(
      new StaleBlockError([{ index: 0, id: 'b-1', expected: STALE, markdown: 'first {#b-1}' } as never]),
    )
    const { client } = await connect()
    await client.listTools()

    await expect(client.callTool({
      name: 'updateBlocks',
      arguments: { path: 'intro', blocks: [{ id: 'b-1', expect: STALE, markdown: 'agent rewrite' }] },
    })).rejects.toThrow(/output schema/)
  })
  it('hands the session markdown the parser reads as the model\'s text', async () => {
    routeAgentEdit.mockResolvedValue({
      nid: 7,
      entry: 'started',
      observers: 0,
      applied: { fields: [], body: false, blocks: { 'b-1': '05b561c1ae22' } },
    })
    const { client } = await connect()
    await client.listTools()

    await client.callTool({
      name: 'updateBlocks',
      arguments: {
        path: 'intro',
        blocks: [{ id: 'b-1', markdown: 'Wiki & AI, 5 < 6, <span>x</span>\n\n```\ncode & fence\n```' }],
      },
    })

    // Only the tag the parser would otherwise swallow is encoded (ADR 0014);
    // the rest is text to it already, and code stays verbatim.
    expect(routeAgentEdit.mock.calls[0]![3]).toEqual({
      blocks: [{
        id: 'b-1',
        markdown: 'Wiki & AI, 5 < 6, &lt;span>x&lt;/span>\n\n```\ncode & fence\n```',
      }],
    })
  })

  it('a conflict hands back the block as text, ready to re-apply', async () => {
    routeAgentEdit.mockRejectedValue(new StaleBlockError([{
      index: 0,
      id: 'b-1',
      expected: STALE,
      version: '28de1f57b3d1',
      markdown: 'Wiki &amp; AI {#b-1}',
    }]))
    const { client } = await connect()
    await client.listTools()

    const res = await client.callTool({
      name: 'updateBlocks',
      arguments: { path: 'intro', blocks: [{ id: 'b-1', expect: STALE, markdown: 'agent rewrite' }] },
    })

    expect((res.structuredContent as any).conflicts[0].markdown).toBe('Wiki & AI {#b-1}')
    expect((res.content as any[])[0].text).toContain('Wiki & AI {#b-1}')
  })
})
