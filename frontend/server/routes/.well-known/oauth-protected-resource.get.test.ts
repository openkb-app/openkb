import { describe, it, expect, vi } from 'vitest'
import rootForm from './oauth-protected-resource.get'
import pathForm from './oauth-protected-resource/mcp.get'
import { makeEvent, type FakeEvent } from '../../test-support/h3'

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

/** A request to `path` on the frontend host. */
function eventFor(path: string): FakeEvent {
  return makeEvent({ host: HOST }, { path })
}

describe('GET /.well-known/oauth-protected-resource', () => {
  it('serves the same document as the path-suffixed form', async () => {
    const root = await rootForm(eventFor('/.well-known/oauth-protected-resource'))
    const suffixed = await pathForm(eventFor('/.well-known/oauth-protected-resource/mcp'))
    expect(root).toEqual(suffixed)
    // Which names the endpoint the client was looking for, so it can carry on.
    expect(root.resource).toBe(`http://${HOST}/mcp`)
  })

  it('is open to any origin, as discovery has to be', async () => {
    const event = eventFor('/.well-known/oauth-protected-resource')
    await rootForm(event)
    expect(event.sent['access-control-allow-origin']).toBe('*')
  })
})
