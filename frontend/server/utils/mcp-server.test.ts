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
  callDrupalTool,
  listDrupalTools,
  toolManifest,
  manifestOf,
  SESSION_TOOLS,
  INSTRUCTIONS,
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
 * Drupal's tools, the texts Drupal describes them with, and how a thrown error
 * is shaped.
 */

vi.mock('./kb-read', () => kbReadMock)
vi.mock('./drupal', () => drupalMock)
vi.mock('./session-router', importOriginal => sessionRouterMock(importOriginal))
vi.mock('./hocuspocus', () => hocuspocusMock)
vi.mock('./drupal-tools', () => drupalToolsMock)
vi.mock('./tool-manifest', () => toolManifestMock)

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

  it('presents itself with the app icons, on the origin the client reached', async () => {
    const { client } = await connect()
    const info = client.getServerVersion()!
    expect(info.title).toBe('OpenKnowledgebase')
    expect(info.description).toBeTruthy()
    expect(info.icons?.map(icon => icon.src)).toEqual([
      'http://kb.example.test/okb-app-icon.svg',
      'http://kb.example.test/okb-app-icon-192.png',
      'http://kb.example.test/okb-app-icon-512.png',
    ])
  })

  it('serves Drupal\'s instructions at initialize', async () => {
    const { client } = await connect()
    expect(client.getInstructions()).toBe(INSTRUCTIONS)
  })

  it('describes each session tool and its arguments as Drupal does', async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    const tool = tools.find(t => t.name === 'getPageForEditing')!

    expect(tool.description).toBe('Drupal describes get_page_for_editing.')
    expect((tool.inputSchema.properties as any).path).toEqual({
      type: 'string',
      description: 'Drupal describes get_page_for_editing\'s path.',
    })
    // The executable schema stays this server's.
    expect(tool.inputSchema.required).toEqual(['path'])
    expect((tool.inputSchema.properties as any).includeResolved).toEqual({ type: 'boolean' })
  })

  it('takes the descriptions of nested arguments from Drupal', async () => {
    const manifest = manifestOf(SESSION_TOOLS)
    manifest.tools.set('update_blocks', {
      description: 'Drupal describes update_blocks.',
      inputSchema: {
        properties: {
          blocks: {
            description: 'The ops, in order.',
            items: { properties: { expect: { description: 'The version you read.' } } },
          },
        },
      },
    })
    toolManifest.mockResolvedValue(manifest)
    const { client } = await connect()
    const { tools } = await client.listTools()
    const blocks = (tools.find(t => t.name === 'updateBlocks')!.inputSchema.properties as any).blocks

    expect(blocks.description).toBe('The ops, in order.')
    expect(blocks.items.properties.expect).toEqual({ type: 'string', description: 'The version you read.' })
    expect(blocks.items.properties.markdown).toEqual({ type: 'string' })
    expect(blocks.items.required).toEqual(['markdown'])
  })

  // The three session tools, and the same three Drupal declares as Tool API
  // plugins so one plugin manager knows the whole surface (openkb_tools,
  // ToolParityTest). Drupal offers none of them — it cannot execute them —
  // so this list and the relayed Drupal tools together are /mcp.
  it('lists the read and write tools it executes itself', async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    expect(tools.map(t => t.name).sort())
      .toEqual(['commentOnBlock', 'getPageForEditing', 'updateBlocks', 'updateFields', 'waitForChanges'])
  })

  it('leaves out and refuses a session tool Drupal does not enable', async () => {
    toolManifest.mockResolvedValue(manifestOf(['get_page_for_editing']))
    listDrupalTools.mockResolvedValue([
      { name: 'tool_api__list_spaces', description: 'x', inputSchema: { type: 'object' } },
    ])
    const { client } = await connect()

    const { tools } = await client.listTools()
    expect(tools.map(t => t.name).sort()).toEqual(['getPageForEditing', 'tool_api__list_spaces'])

    const res = await client.callTool({
      name: 'updateBlocks',
      arguments: { path: 'intro', blocks: [{ id: 'b-1', markdown: 'One.' }] },
    })
    expect(res.isError).toBe(true)
    expect((res.content as any[])[0].text).toBe('updateBlocks is not enabled on this site.')
    expect(routeAgentEdit).not.toHaveBeenCalled()
    expect(callDrupalTool).not.toHaveBeenCalled()
  })

  // Which session tools exist is Drupal's to say; without an answer the server
  // guesses neither all nor none.
  it('answers an unreadable tool manifest with an error', async () => {
    toolManifest.mockRejectedValue(new Error('Drupal answered the tool manifest with 503'))

    await expect(connect()).rejects.toThrow('tool manifest')
    expect(getKbPage).not.toHaveBeenCalled()
  })

  it('refuses a call when the manifest turns unreadable after initialize', async () => {
    const { client } = await connect()
    toolManifest.mockRejectedValue(new Error('Drupal answered the tool manifest with 503'))

    await expect(client.listTools()).rejects.toThrow('tool manifest')
    const res = await client.callTool({ name: 'getPageForEditing', arguments: { path: 'intro' } })
    expect(res.isError).toBe(true)
    expect(getKbPage).not.toHaveBeenCalled()
  })

  it('the test-drive flow still closes: read the draft, edit the block it named, read it back', async () => {
    getKbPage.mockResolvedValue(PAGE)
    routeAgentEdit.mockResolvedValue({
      nid: 7,
      entry: 'started',
      observers: 0,
      applied: { fields: [], blocks: { 'b-1': '28de1f57b3d1' }, unchanged: [], removed: [] },
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
