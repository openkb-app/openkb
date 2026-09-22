import { describe, it, expect, vi } from 'vitest'
import type { H3Event } from 'h3'
import handler from './health.get'

vi.mock('nitropack/runtime', () => ({
  useNitroApp: () => ({
    hocuspocus: {
      getDocumentsCount: () => 2,
      getConnectionsCount: () => 5,
    },
  }),
}))

describe('GET /api/collab/health', () => {
  it('returns aggregate counts and uptime only', async () => {
    const result = await handler({} as H3Event) as Record<string, unknown>

    expect(result).toEqual({
      status: 'ok',
      documents: 2,
      connections: 5,
      uptime: expect.any(Number),
    })
    // No document names or per-document detail may leak.
    expect(Object.keys(result).sort()).toEqual(['connections', 'documents', 'status', 'uptime'])
  })
})
