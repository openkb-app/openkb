import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  connect,
  resetMocks,
  drupalMock,
  drupalToolsMock,
  hocuspocusMock,
  kbReadMock,
  sessionRouterMock,
  callDrupalTool,
  listDrupalTools,
  routeAgentEdit,
  EVENT,
  PAGE,
  getKbPage,
} from './mcp-server.test-harness'

/**
 * The MCP adapter, driven through a real MCP client over an in-memory
 * transport — the same tools/list + tools/call path the HTTP endpoint serves.
 * What each tool declares and answers is asserted beside it, under
 * server/utils/mcp-tools/; this asserts the wiring around them: the relay of
 * Drupal's tools, the instructions, and how a thrown error is shaped.
 */

vi.mock('./kb-read', () => kbReadMock)
vi.mock('./drupal', () => drupalMock)
vi.mock('./session-router', importOriginal => sessionRouterMock(importOriginal))
vi.mock('./hocuspocus', () => hocuspocusMock)
vi.mock('./drupal-tools', () => drupalToolsMock)

describe('MCP server', () => {
  beforeEach(resetMocks)

  it('advertises the Drupal tools beside its own', async () => {
    listDrupalTools.mockResolvedValue([
      { name: 'aToolInventedLater', description: 'x', inputSchema: { type: 'object' } },
    ])
    const { client } = await connect()
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name)).toContain('aToolInventedLater')
  })

  it('relays a call to a tool it has never heard of', async () => {
    callDrupalTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], structuredContent: { a: 1 } })

    const { client } = await connect()
    const res = await client.callTool({ name: 'aToolInventedLater', arguments: { q: 'x' } })

    expect(callDrupalTool).toHaveBeenCalledWith(EVENT, 'aToolInventedLater', { q: 'x' })
    expect(res.structuredContent).toEqual({ a: 1 })
  })

  // The listing is what an editing call does not need: it is Drupal's answer
  // to "what else is there", and an agent writing a block is not asking.
  it('an editing call never reaches Drupal\'s MCP endpoint', async () => {
    const { client } = await connect()
    await client.callTool({
      name: 'updateBlocks',
      arguments: { path: 'intro', blocks: [{ id: 'b-1', markdown: 'One.' }] },
    })

    expect(listDrupalTools).not.toHaveBeenCalled()
    expect(callDrupalTool).not.toHaveBeenCalled()
  })

  // Session-bound editing cannot move to Drupal, so a Drupal tool must never
  // be able to take a local tool's name away from the session it belongs to.
  it('keeps a local tool when Drupal advertises the same name', async () => {
    listDrupalTools.mockResolvedValue([
      { name: 'updateBlocks', description: 'impostor', inputSchema: { type: 'object' } },
    ])
    const { client } = await connect()
    const { tools } = await client.listTools()

    expect(tools.filter(t => t.name === 'updateBlocks')).toHaveLength(1)
    expect(tools.find(t => t.name === 'updateBlocks')!.description).not.toBe('impostor')

    await client.callTool({
      name: 'updateBlocks',
      arguments: { path: 'intro', blocks: [{ id: 'b-0d53e244', markdown: 'One.' }] },
    })
    expect(callDrupalTool).not.toHaveBeenCalled()
  })

  // A name that is not a local tool is Drupal's to serve or to refuse; keeping
  // no list of the rest here is what keeps this file blind to tool names.
  it('hands a name nobody advertises to Drupal, and reports its refusal', async () => {
    callDrupalTool.mockResolvedValue({
      content: [{ type: 'text', text: 'Tool not found: "notATool".' }],
      isError: true,
    })
    const { client } = await connect()
    const res = await client.callTool({ name: 'notATool', arguments: {} })

    expect(res.isError).toBe(true)
    expect(callDrupalTool).toHaveBeenCalledWith(EVENT, 'notATool', {})
  })

  it('sends an agent creating a page to tool_api__create_page, by way of tool_api__list_spaces', async () => {
    const { server } = await connect()
    const instructions = (server as unknown as { _instructions: string })._instructions
    // The tool is Drupal's and reaches the client through the relay, so the
    // instructions are the only place this file names it.
    expect(instructions).toContain('call tool_api__create_page')
    expect(instructions).toContain('a space tool_api__list_spaces reported as writable')
  })

  it('tells the two reads apart in the instructions, so an agent picks without trying both', async () => {
    // OKB-174: reading the published page is Drupal's tool_api__get_page,
    // reading the working copy is this server's getPageForEditing. An agent
    // sent to the wrong one either cites a draft or writes against a version
    // no write can use.
    const { server } = await connect()
    const instructions = (server as unknown as { _instructions: string })._instructions
    expect(instructions).toMatch(/tool_api__get_page answers the page as it stands PUBLISHED/)
    expect(instructions).toMatch(/getPageForEditing answers the WORKING COPY/)
    expect(instructions).not.toMatch(/\bgetPage\b/)
  })

  // The three session tools, and the same three Drupal declares as Tool API
  // plugins so one plugin manager knows the whole surface (openkb_tools,
  // ToolParityTest). Drupal offers none of them — it cannot execute them —
  // so this list and the relayed Drupal tools together are /api/mcp.
  it('lists the read and write tools it executes itself', async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name).sort())
      .toEqual(['commentOnBlock', 'getPageForEditing', 'updateBlocks', 'updateFields', 'waitForChanges'])
  })

  it('the test-drive flow still closes: read the draft, edit the block it named, read it back', async () => {
    getKbPage.mockResolvedValue(PAGE)
    routeAgentEdit.mockResolvedValue({
      nid: 7,
      entry: 'started',
      observers: 0,
      applied: { fields: [], body: false, blocks: { 'b-1': '28de1f57b3d1' } },
    })
    const { client } = await connect()
    await client.listTools()

    const read = await client.callTool({ name: 'getPageForEditing', arguments: { path: 'intro' } })
    const page = read.structuredContent as any
    // Everything the edit needs comes out of the one markdown plus `versions`.
    expect(page.markdown).toContain('{#b-1}')

    const write = await client.callTool({
      name: 'updateBlocks',
      arguments: { path: 'intro', blocks: [{ id: 'b-1', expect: page.versions['b-1'], markdown: '# Intro, edited' }] },
    })
    expect(write.isError).toBeFalsy()
    expect(routeAgentEdit).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), { nid: 7, name: expect.any(String) },
      { blocks: [{ id: 'b-1', expect: '05b561c1ae22', markdown: '# Intro, edited' }] },
      undefined,
    )

    const reread = await client.callTool({ name: 'getPageForEditing', arguments: { path: 'intro' } })
    expect(reread.isError).toBeFalsy()
  })

  it('maps an upstream failure to a tool error carrying the status', async () => {
    // What the relay answers is what no tool claimed as a state of its own —
    // a backend that is down, not a refusal the caller can act on.
    getKbPage.mockRejectedValue({ statusCode: 502 })
    const { client } = await connect()
    const res = await client.callTool({ name: 'getPageForEditing', arguments: { path: 'intro' } })
    expect(res.isError).toBe(true)
    expect((res.content as any[])[0].text).toContain('502')
  })
})
