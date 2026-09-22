import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  connect,
  resetMocks,
  drupalMock,
  drupalToolsMock,
  hocuspocusMock,
  kbReadMock,
  sessionRouterMock,
  findKbPageByPath,
  routeAgentEdit,
} from '../mcp-server.test-harness'
import { AgentJoinError, AgentOpsError } from '../session-router'

/**
 * updateFields, driven through a real MCP client. The session router is mocked
 * — it is covered by session-router.test.ts — but its error classes are real,
 * which is what exercises the tool's refusal mapping for what it is.
 */

vi.mock('../kb-read', () => kbReadMock)
vi.mock('../drupal', () => drupalMock)
vi.mock('../session-router', importOriginal => sessionRouterMock(importOriginal))
vi.mock('../hocuspocus', () => hocuspocusMock)
vi.mock('../drupal-tools', () => drupalToolsMock)

describe('updateFields', () => {
  beforeEach(resetMocks)

  it("updateFields' input schema is the exposure contract itself", async () => {
    const { client } = await connect()
    const updateFields = (await client.listTools()).tools.find(t => t.name === 'updateFields')!
    const fields = (updateFields.inputSchema as Record<string, any>).properties.fields
    // Writable keys track the form display — no field list in the tool.
    expect(Object.keys(fields.properties).sort()).toEqual(['owner', 'summary'])
  })

  it('updateFields keeps the shapes Drupal accepts and drops the widget rendering details', async () => {
    const { client } = await connect()
    const { tools } = await client.listTools()
    const fields = (tools.find(t => t.name === 'updateFields')!.inputSchema as Record<string, any>)
      .properties.fields

    // Form concerns — rows, placeholders, autocomplete match limits — stay
    // server-side; nothing an agent writes with is lost.
    expect(JSON.stringify(fields)).not.toContain('x-widget')
    expect(fields.properties.summary).toEqual({ type: 'string', 'x-field-name': 'field_summary' })
    expect(fields.required).toEqual(['summary'])

    // And the same schema feeds the read tool's projection, so neither payload
    // carries the hints.
    const frontmatter = (tools.find(t => t.name === 'getPageForEditing')!.outputSchema as Record<string, any>)
      .properties.frontmatter
    expect(JSON.stringify(frontmatter)).not.toContain('x-widget')
  })

  it('updateFields routes the values through the session and reports what it did', async () => {
    const { client } = await connect()
    const res = await client.callTool({
      name: 'updateFields',
      arguments: { path: 'intro', fields: { summary: 'A new summary.' } },
    })

    expect(res.isError).toBeFalsy()
    expect(routeAgentEdit).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), { nid: 7, name: expect.any(String) }, { fields: { summary: 'A new summary.' } }, undefined,
    )
    expect(res.structuredContent).toEqual({
      ok: true,
      nid: 7,
      entry: 'started',
      observers: 0,
      applied: { fields: ['summary'], body: false, blocks: {} },
    })
  })

  it('an unknown field key is answered per field, not refused as an undeclared argument', async () => {
    routeAgentEdit.mockRejectedValue(new AgentOpsError({ not_a_field: ['Unknown field.'] }))
    const { client } = await connect()
    const res = await client.callTool({
      name: 'updateFields',
      arguments: { path: 'intro', fields: { not_a_field: 'x' } },
    })

    // The field set is the site's, so the argument check must not close it:
    // the write answers, and the agent gets the structured message.
    expect(res.structuredContent).toMatchObject({ ok: false, errors: { not_a_field: ['Unknown field.'] } })
    expect(routeAgentEdit).toHaveBeenCalled()
  })

  it('a rejected value comes back as a structured per-field refusal', async () => {
    routeAgentEdit.mockRejectedValue(new AgentOpsError({ summary: ['Too long.'] }))
    const { client } = await connect()
    const res = await client.callTool({
      name: 'updateFields',
      arguments: { path: 'intro', fields: { summary: 'x'.repeat(500) } },
    })

    expect(res.isError).toBe(true)
    // Structured, not prose: the agent can act on the per-field messages, and
    // the client validates them against the tool's declared output schema.
    expect(res.structuredContent).toMatchObject({ ok: false, errors: { summary: ['Too long.'] } })
    expect((res.content as any[])[0].text).toContain('nothing was written')
  })

  it('a refused join is a tool result, not a transport failure', async () => {
    routeAgentEdit.mockRejectedValue(new AgentJoinError('scope', 'The "agent_write" scope is required to edit.'))
    const { client } = await connect()
    const res = await client.callTool({ name: 'updateFields', arguments: { path: 'intro', fields: {} } })

    expect(res.isError).toBe(true)
    expect((res.structuredContent as any).ok).toBe(false)
    expect((res.content as any[])[0].text).toContain('agent_write')
  })

  it('an unknown path is refused without touching the router', async () => {
    findKbPageByPath.mockResolvedValue(null)
    const { client } = await connect()
    const res = await client.callTool({ name: 'updateFields', arguments: { path: 'nope', fields: {} } })

    expect(res.isError).toBe(true)
    expect((res.content as any[])[0].text).toContain('Page not found')
    expect(routeAgentEdit).not.toHaveBeenCalled()
  })
})
