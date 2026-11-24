import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchAccountNames } from './account-names'

const drupalFetchWithAuth = vi.fn()
const collabIdentityConfigured = vi.fn()

vi.mock('./drupal', () => ({
  drupalFetchWithAuth: (...a: unknown[]) => drupalFetchWithAuth(...a),
}))
vi.mock('./collab-identity', () => ({
  collabIdentityConfigured: () => collabIdentityConfigured(),
  asCollabServer: (run: (auth: Record<string, string>) => Promise<unknown>) => run({ Authorization: 'Bearer collab' }),
}))

/** One JSON:API user row. */
function userRow(uid: number, name: string) {
  return { id: `uuid-${uid}`, attributes: { name, drupal_internal__uid: uid } }
}

describe('fetchAccountNames', () => {
  beforeEach(() => {
    drupalFetchWithAuth.mockReset()
    collabIdentityConfigured.mockReset().mockReturnValue(true)
  })

  it('reads names as the collab server, not the caller', async () => {
    drupalFetchWithAuth.mockResolvedValue({ data: [userRow(2, 'editor2-renamed'), userRow(3, 'agent-owner')] })

    const names = await fetchAccountNames([2, 3, 2, 0])

    expect(names).toEqual(new Map([[2, 'editor2-renamed'], [3, 'agent-owner']]))
    expect(drupalFetchWithAuth).toHaveBeenCalledOnce()
    expect(drupalFetchWithAuth.mock.calls[0]![0]).toEqual({ Authorization: 'Bearer collab' })
  })

  it('reads nothing without a collab identity', async () => {
    collabIdentityConfigured.mockReturnValue(false)

    expect(await fetchAccountNames([2])).toEqual(new Map())
    expect(drupalFetchWithAuth).not.toHaveBeenCalled()
  })

  it('answers no names when the lookup fails', async () => {
    drupalFetchWithAuth.mockRejectedValue(new Error('503'))

    expect(await fetchAccountNames([2])).toEqual(new Map())
  })
})
