import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { H3Event } from 'h3'

/**
 * The aggregate probe next door is unauthenticated and therefore aggregate-only
 * — per-document detail confirms a node exists. This one answers per document,
 * so what is pinned here is that it never answers at all to a caller who has
 * not proved VIEW access, and that "refused" and "no such node" are the same
 * response.
 */

const fetchCeNode = vi.fn()
vi.mock('../../../../utils/drupal', () => ({
  fetchCeNode: (...a: unknown[]) => fetchCeNode(...a),
}))

const documents = new Map<string, { getConnectionsCount: () => number }>()
vi.mock('../../../../utils/hocuspocus', () => ({
  useHocuspocus: () => ({ documents }),
}))

const handler = (await import('./[nid].get')).default as unknown as
  (event: H3Event) => Promise<unknown>

function event(nid: string): H3Event {
  return { context: { params: { nid } }, node: { req: { headers: { cookie: 'SESS=1' } } } } as unknown as H3Event
}

/** The error a refusal throws, whatever the reason for it. */
async function refusalOf(nid: string): Promise<Record<string, unknown>> {
  try {
    await handler(event(nid))
    throw new Error(`expected /api/collab/health/node/${nid} to refuse`)
  }
  catch (err) {
    const e = err as { statusCode?: number, statusMessage?: string, message?: string }
    return { statusCode: e.statusCode, statusMessage: e.statusMessage, message: e.message }
  }
}

describe('GET /api/collab/health/node/:nid', () => {
  beforeEach(() => {
    documents.clear()
    fetchCeNode.mockReset().mockResolvedValue({ page: { nid: 7, title: 'Visible' } })
  })

  it('reports the peers on the caller\'s own document', async () => {
    documents.set('node:7', { getConnectionsCount: () => 2 })

    await expect(handler(event('7'))).resolves.toEqual({ live: true, connections: 2 })
  })

  it('reports a document nobody has open as settled', async () => {
    await expect(handler(event('7'))).resolves.toEqual({ live: false, connections: 0 })
  })

  it('answers for its own document while others are live', async () => {
    documents.set('node:7', { getConnectionsCount: () => 1 })
    documents.set('node:8', { getConnectionsCount: () => 9 })

    const result = await handler(event('7')) as Record<string, unknown>
    expect(result).toEqual({ live: true, connections: 1 })
    // Neither the other document's name nor its peers may appear.
    expect(Object.keys(result).sort()).toEqual(['connections', 'live'])
    expect(JSON.stringify(result)).not.toContain('node:8')
  })

  it('does not consult the collab server before access is decided', async () => {
    documents.set('node:7', { getConnectionsCount: () => 3 })
    fetchCeNode.mockRejectedValue(Object.assign(new Error('Not Found'), { statusCode: 404 }))

    await expect(handler(event('7'))).rejects.toMatchObject({ statusCode: 404 })
  })

  it('refuses every caller who cannot see the node identically', async () => {
    // A live document, so any leak of what the server holds would show.
    documents.set('node:7', { getConnectionsCount: () => 3 })

    // The ce-api read tells absent from forbidden, and this route tells
    // neither: unknown nid, hidden space and refused carrier answer alike.
    const outcomes = []
    for (const upstream of [
      () => fetchCeNode.mockRejectedValue(Object.assign(new Error('Not Found'), { statusCode: 404 })),
      // Drupal refusing the carrier outright — an anonymous caller on a site
      // without `access content`.
      () => fetchCeNode.mockRejectedValue(Object.assign(new Error('Forbidden'), { statusCode: 403 })),
      // Drupal unreachable: still no proof of access, so still no answer.
      () => fetchCeNode.mockRejectedValue(new Error('ECONNREFUSED')),
    ]) {
      upstream()
      outcomes.push(await refusalOf('7'))
    }

    expect(outcomes[0]).toMatchObject({ statusCode: 404, statusMessage: 'Not Found' })
    for (const outcome of outcomes) expect(outcome).toEqual(outcomes[0])
  })

  it('refuses a malformed id without asking Drupal about it', async () => {
    for (const nid of ['0', '-1', 'abc', '1.5', '', '9007199254740993']) {
      expect(await refusalOf(nid)).toMatchObject({ statusCode: 404, statusMessage: 'Not Found' })
    }
    expect(fetchCeNode).not.toHaveBeenCalled()
  })
})
