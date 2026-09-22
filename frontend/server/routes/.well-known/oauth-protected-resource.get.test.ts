import { describe, it, expect, vi } from 'vitest'
import type { H3Event } from 'h3'
import rootForm from './oauth-protected-resource.get'
import pathForm from './oauth-protected-resource/api/mcp.get'

/**
 * The root-form protected-resource document.
 *
 * A client handed the site origin derives this URL rather than the path-
 * suffixed one, so what it has to answer with is the same document — pinned
 * against the path form itself, not against a copy of its fields.
 */

const DRUPAL = 'http://drupal.example.test:8080'
const HOST = 'kb.example.test:8091'

vi.mock('../../utils/drupal', () => ({ drupalBaseUrl: () => DRUPAL }))
vi.mock('../../utils/upstream', () => ({
  fetchUpstream: async () => ({ ok: true, json: async () => ({ scopes_supported: ['agent:read'] }) }),
}))

/** An event, capturing the headers the route sets on it. */
function eventFor(path: string): { event: H3Event, headers: Record<string, string> } {
  const headers: Record<string, string> = {}
  const event = {
    path,
    node: {
      req: { url: path, headers: { host: HOST } },
      res: { setHeader: (name: string, value: string) => { headers[name] = value } },
    },
  } as unknown as H3Event
  return { event, headers }
}

describe('GET /.well-known/oauth-protected-resource', () => {
  it('serves the same document as the path-suffixed form', async () => {
    const root = await rootForm(eventFor('/.well-known/oauth-protected-resource').event)
    const suffixed = await pathForm(eventFor('/.well-known/oauth-protected-resource/api/mcp').event)
    expect(root).toEqual(suffixed)
    // Which names the endpoint the client was looking for, so it can carry on.
    expect(root.resource).toBe(`http://${HOST}/api/mcp`)
  })

  it('is open to any origin, as discovery has to be', async () => {
    const { event, headers } = eventFor('/.well-known/oauth-protected-resource')
    await rootForm(event)
    expect(headers['access-control-allow-origin']).toBe('*')
  })
})
