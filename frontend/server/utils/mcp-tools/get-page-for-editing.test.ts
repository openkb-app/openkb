import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  connect,
  resetMocks,
  drupalMock,
  drupalToolsMock,
  hocuspocusMock,
  kbReadMock,
  sessionRouterMock,
  EVENT,
  PAGE,
  fetchFrontmatterSchema,
  getKbPage,
} from '../mcp-server.test-harness'

/**
 * getPageForEditing, driven through a real MCP client. The read layer and the
 * schema fetch are mocked; this asserts the tool contract, the
 * schema-follows-the-form property, and how a refused read is shaped.
 */

vi.mock('../kb-read', () => kbReadMock)
vi.mock('../drupal', () => drupalMock)
vi.mock('../session-router', importOriginal => sessionRouterMock(importOriginal))
vi.mock('../hocuspocus', () => hocuspocusMock)
vi.mock('../drupal-tools', () => drupalToolsMock)

describe('getPageForEditing', () => {
  beforeEach(resetMocks)

  it('documents `status` as the answer to whether a page is writable', async () => {
    // It is served only to an account that may edit (kb-read.ts), so its
    // presence already answers writability — the tool just has to say so.
    // No `permissions` field: nothing new is computed for this.
    const { client } = await connect()
    const tool = (await client.listTools()).tools.find(t => t.name === 'getPageForEditing')!

    const status = (tool.outputSchema as Record<string, any>).properties.status
    expect(status.description).toMatch(/presence is what tells you the page is writable/)
    expect((tool.outputSchema as Record<string, any>).properties).not.toHaveProperty('permissions')
  })

  it('getPageForEditing output schema tracks the frontmatter form (schema-follows)', async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    const tool = tools.find(t => t.name === 'getPageForEditing')!
    const frontmatter = (tool.outputSchema as Record<string, any>).properties.frontmatter
    // Exactly the exposed fields — no hardcoded list.
    expect(Object.keys(frontmatter.properties).sort()).toEqual(['owner', 'summary'])
    // Each field is widened to also accept the projection's null-for-empty.
    expect(frontmatter.properties.summary).toEqual({
      anyOf: [{ type: 'string', 'x-field-name': 'field_summary' }, { type: 'null' }],
    })
    // A field removed from the form disappears from the tool schema.
    fetchFrontmatterSchema.mockResolvedValue({
      type: 'object',
      properties: { summary: { type: 'string', 'x-field-name': 'field_summary' } },
    })
    const { client: client2 } = await connect()
    const narrowed = (await client2.listTools()).tools.find(t => t.name === 'getPageForEditing')!
    expect(
      Object.keys((narrowed.outputSchema as Record<string, any>).properties.frontmatter.properties),
    ).toEqual(['summary'])
  })

  it('getPageForEditing declares the page once — markdown, and no second body beside it', async () => {
    const { client } = await connect()
    const tool = (await client.listTools()).tools.find(t => t.name === 'getPageForEditing')!
    const output = tool.outputSchema as Record<string, any>
    expect(Object.keys(output.properties).sort())
      .toEqual(['comments', 'frontmatter', 'markdown', 'path', 'status', 'title', 'versions'])
    expect(output.required).not.toContain('body')

    // Enforced, not merely undeclared: the schema is closed, so a second copy
    // of the body would be refused.
    getKbPage.mockResolvedValue({ ...PAGE, body: '# Intro {#b-1}' })
    await expect(client.callTool({ name: 'getPageForEditing', arguments: { path: 'intro' } }))
      .rejects.toThrow(/output schema/)
  })

  it('getPageForEditing reports the moderation standing as data the schema declares', async () => {
    getKbPage.mockResolvedValue({
      ...PAGE,
      status: { draft_exists: true, blocks_pending: 2, can_publish: false },
    })
    const { client } = await connect()
    await client.listTools()

    const res = await client.callTool({ name: 'getPageForEditing', arguments: { path: 'intro' } })

    expect((res.structuredContent as any).status)
      .toEqual({ draft_exists: true, blocks_pending: 2, can_publish: false })
    // The status costs the moderation read, so the tool has to ask for it.
    expect(getKbPage).toHaveBeenCalledWith(
      EVENT,
      'intro',
      { version: 'working-copy', withStatus: true, withComments: true },
    )
  })

  it('a page without an editorial standing is still a valid page', async () => {
    // A reader who may not edit gets no status — the field is optional, not
    // a null the caller has to test for.
    getKbPage.mockResolvedValue(PAGE)
    const { client } = await connect()
    await client.listTools()

    const res = await client.callTool({ name: 'getPageForEditing', arguments: { path: 'intro' } })

    expect(res.isError).toBeFalsy()
    expect((res.structuredContent as any).status).toBeUndefined()
  })

  it('the status schema is enforced: a half-answered standing is refused', async () => {
    getKbPage.mockResolvedValue({ ...PAGE, status: { draft_exists: true } })
    const { client } = await connect()
    await client.listTools()

    await expect(client.callTool({ name: 'getPageForEditing', arguments: { path: 'intro' } }))
      .rejects.toThrow(/output schema/)
  })

  it('getPageForEditing returns the markdown and structured page', async () => {
    getKbPage.mockResolvedValue(PAGE)
    const { client } = await connect()
    // Listing caches the output schema, so the result below is validated
    // against it rather than eyeballed.
    await client.listTools()
    const res = await client.callTool({ name: 'getPageForEditing', arguments: { path: 'intro' } })
    expect(res.isError).toBeFalsy()
    expect((res.content as any[])[0].text).toContain('# Intro')
    expect((res.structuredContent as any).title).toBe('Intro')
    expect(getKbPage).toHaveBeenCalledWith(
      EVENT,
      'intro',
      { version: 'working-copy', withStatus: true, withComments: true },
    )
  })

  it('reads the working copy, and offers no way to ask for anything else', async () => {
    // The split is the whole point (OKB-174): the published page is Drupal's
    // tool_api__get_page, so there is no revision to choose here and no input
    // that would choose one. What a reader may ask about is which
    // conversations it wants, not which revision.
    getKbPage.mockResolvedValue({ ...PAGE, markdown: '---\nsummary: Draft summary.\n---\n\nDraft body. {#b-1}' })
    const { client } = await connect()
    const tool = (await client.listTools()).tools.find(t => t.name === 'getPageForEditing')!
    const input = tool.inputSchema as Record<string, any>
    expect(Object.keys(input.properties)).toEqual(['path', 'includeResolved'])
    expect(input.additionalProperties).toBe(false)

    const res = await client.callTool({ name: 'getPageForEditing', arguments: { path: 'intro' } })
    expect(res.isError).toBeFalsy()
    expect(getKbPage).toHaveBeenCalledWith(
      EVENT,
      'intro',
      { version: 'working-copy', withStatus: true, withComments: true },
    )
  })

  it('getPageForEditing reports a missing page as a tool error, not a crash', async () => {
    getKbPage.mockResolvedValue(null)
    const { client } = await connect()
    const res = await client.callTool({ name: 'getPageForEditing', arguments: { path: 'nope' } })
    expect(res.isError).toBe(true)
    expect((res.content as any[])[0].text).toContain('nope')
  })

  it('tells a reader the page is read-only, not that a request failed', async () => {
    // The refusal is routine for every reader, so it names the state and the
    // way on rather than the status the read path answered with.
    getKbPage.mockRejectedValue({ statusCode: 403 })
    const { client } = await connect()
    const res = await client.callTool({ name: 'getPageForEditing', arguments: { path: 'intro' } })
    expect(res.isError).toBe(true)
    const text = (res.content as any[])[0].text as string
    expect(text).toContain('read-only for you')
    expect(text).toContain('tool_api__get_page')
    expect(text).not.toContain('403')
  })

  it('getPageForEditing rejects an empty path before hitting the read layer', async () => {
    const { client } = await connect()
    const res = await client.callTool({ name: 'getPageForEditing', arguments: { path: '' } })
    expect(res.isError).toBe(true)
    expect(getKbPage).not.toHaveBeenCalled()
  })

  it('degrades the read output schema to an open object when the schema fetch fails', async () => {
    fetchFrontmatterSchema.mockRejectedValue(new Error('down'))
    const { client } = await connect()
    const tool = (await client.listTools()).tools.find(t => t.name === 'getPageForEditing')!
    const frontmatter = (tool.outputSchema as Record<string, any>).properties.frontmatter
    expect(frontmatter).toEqual({ type: 'object' })
  })
  it('serves the page markdown as the read path projected it', async () => {
    // The entity boundary is the read path's, not this tool's (ADR 0014) —
    // kb-read.test.ts pins it. Here: the text block and the structured field
    // carry the same bytes.
    getKbPage.mockResolvedValue({ ...PAGE, markdown: '---\nsummary: null\n---\n\nWiki & AI {#b-1}' })
    const { client } = await connect()
    const res = await client.callTool({ name: 'getPageForEditing', arguments: { path: 'intro' } })

    const markdown = (res.structuredContent as any).markdown as string
    expect(markdown).toContain('Wiki & AI {#b-1}')
    expect((res.content as any[])[0].text).toBe(markdown)
  })
})
