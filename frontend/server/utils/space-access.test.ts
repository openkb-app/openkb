import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { H3Event } from 'h3'
import { atLeast, spaceAccessBySlug, spaceAccessMap } from './space-access'

/**
 * The frontend's copy of Drupal's access answer, and what happens when there
 * isn't one.
 *
 * The contract that matters is the failure: search enforces this map on the
 * index, so a map that cannot be read has to raise rather than resolve to
 * something a query could run with. The UI-facing reader is the other half —
 * it answers "nothing" instead, which hides a control rather than failing a
 * page.
 */

function makeEvent(headers: Record<string, string> = { Cookie: 'SESS=x' }): H3Event {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  )
  return { context: {}, node: { req: { headers: lower } } } as unknown as H3Event
}

const SPACES = [
  { slug: 'team-wiki', name: 'Team Wiki', description: 'Notes.', access: 'manage', moderated: true },
  { slug: 'general', name: 'General', description: '', access: 'read', moderated: false },
]

function stubFetch(reply: { status?: number, body?: unknown, offline?: boolean } = {}) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
    calls.push(String(input))
    if (reply.offline) throw new TypeError('fetch failed')
    const status = reply.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => reply.body ?? { spaces: SPACES },
      text: async () => JSON.stringify(reply.body ?? { spaces: SPACES }),
    } as unknown as Response
  }))
  return calls
}

beforeEach(() => {
  vi.stubGlobal('useRuntimeConfig', () => ({ drupalBaseUrl: 'http://drupal.test/' }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('spaceAccessMap', () => {
  it('reads the map from Drupal as the caller', async () => {
    const calls = stubFetch()
    expect(await spaceAccessMap(makeEvent())).toEqual(SPACES)
    expect(calls).toEqual(['http://drupal.test/openkb/spaces'])
  })

  it('reads once per request, however many consumers ask', async () => {
    const calls = stubFetch()
    const event = makeEvent()
    await Promise.all([spaceAccessMap(event), spaceAccessMap(event)])
    await spaceAccessMap(event)
    expect(calls).toHaveLength(1)
  })

  it('raises for an anonymous caller, without asking', async () => {
    const calls = stubFetch()
    await expect(spaceAccessMap(makeEvent({}))).rejects.toMatchObject({ statusCode: 403 })
    expect(calls).toEqual([])
  })

  it('raises when Drupal is unreachable — never an empty answer', async () => {
    stubFetch({ offline: true })
    await expect(spaceAccessMap(makeEvent())).rejects.toMatchObject({ statusCode: 503 })
  })

  it('raises when Drupal refuses the caller', async () => {
    stubFetch({ status: 403 })
    await expect(spaceAccessMap(makeEvent())).rejects.toMatchObject({ statusCode: 403 })
  })

  it('raises on an answer that is not a space list', async () => {
    stubFetch({ body: { error: 'nope' } })
    await expect(spaceAccessMap(makeEvent())).rejects.toMatchObject({ statusCode: 503 })
  })

  it('drops an entry carrying no slug or no known level', async () => {
    stubFetch({
      body: {
        spaces: [
          { slug: '', name: 'Nameless', access: 'read' },
          { slug: 'odd', name: 'Odd', access: 'superuser' },
          SPACES[0],
        ],
      },
    })
    expect((await spaceAccessMap(makeEvent())).map(space => space.slug)).toEqual(['team-wiki'])
  })
})

describe('spaceAccessBySlug', () => {
  it('keys the map by slug', async () => {
    stubFetch()
    const access = await spaceAccessBySlug(makeEvent())
    expect(access.get('team-wiki')?.access).toBe('manage')
    expect(access.get('general')?.access).toBe('read')
  })

  it('answers nothing rather than raising, so a control is hidden not broken', async () => {
    stubFetch({ offline: true })
    expect(await spaceAccessBySlug(makeEvent())).toEqual(new Map())
  })
})

describe('atLeast', () => {
  it('orders the levels read < write < manage', () => {
    expect(atLeast('manage', 'write')).toBe(true)
    expect(atLeast('write', 'write')).toBe(true)
    expect(atLeast('read', 'write')).toBe(false)
    expect(atLeast('write', 'manage')).toBe(false)
  })
})
