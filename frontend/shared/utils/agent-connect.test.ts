import { describe, it, expect } from 'vitest'
import { claudeCodeConnectCommand, mcpEndpoint } from './agent-connect'

/**
 * The page is the only place most people will ever read this URL, and a client
 * pointed one segment wrong is a dead end that costs a session to diagnose
 * (OKB-161). So the snippets have to name the endpoint exactly, whatever shape
 * the origin arrives in.
 */
describe('the connect snippets', () => {
  it('names the MCP endpoint on the origin the reader is on', () => {
    expect(mcpEndpoint('https://kb.example.com')).toBe('https://kb.example.com/api/mcp')
  })

  it('does not double the slash on an origin that carries one', () => {
    expect(mcpEndpoint('http://localhost:8091/')).toBe('http://localhost:8091/api/mcp')
  })

  it('gives Claude Code the endpoint and no credential', () => {
    const command = claudeCodeConnectCommand('https://kb.example.com')
    expect(command).toBe('claude mcp add --transport http openkb https://kb.example.com/api/mcp')
    expect(command).not.toContain('--header')
  })
})
