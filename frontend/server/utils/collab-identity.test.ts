import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

/**
 * The collaboration server's own access token (ADR 0001).
 *
 * What is pinned here is the three things a shared token has to get right:
 * one token request for however many concurrent callers, re-use until it is nearly
 * expired, and a fresh one the moment Drupal stops honouring the held one.
 */

const drupalBaseUrl = vi.fn(() => 'http://drupal.test')
const fetchUpstream = vi.fn()

vi.mock('./drupal', () => ({ drupalBaseUrl }))
vi.mock('./upstream', () => ({ fetchUpstream }))

/** A fresh module instance, so the held token never leaks between cases. */
async function load() {
  vi.resetModules()
  return import('./collab-identity')
}

/** One `/oauth/token` answer. */
function granted(token: string, expiresIn = 300) {
  return { ok: true, status: 200, json: async () => ({ access_token: token, expires_in: expiresIn }) }
}

describe('the collaboration server identity', () => {
  beforeEach(() => {
    fetchUpstream.mockReset()
    process.env.OKB_COLLAB_CLIENT_ID = 'client'
    process.env.OKB_COLLAB_CLIENT_SECRET = 'secret'
  })

  afterEach(() => {
    delete process.env.OKB_COLLAB_CLIENT_ID
    delete process.env.OKB_COLLAB_CLIENT_SECRET
  })

  it('issues once for concurrent callers, and re-uses what it holds', async () => {
    fetchUpstream.mockResolvedValue(granted('first'))
    const { collabAuthHeaders } = await load()

    const [a, b] = await Promise.all([collabAuthHeaders(), collabAuthHeaders()])
    expect(a).toEqual({ Authorization: 'Bearer first' })
    expect(b).toEqual(a)
    expect(await collabAuthHeaders()).toEqual(a)
    expect(fetchUpstream).toHaveBeenCalledTimes(1)

    const [url, init] = fetchUpstream.mock.calls[0]!
    expect(url).toBe('http://drupal.test/oauth/token')
    expect(init.method).toBe('POST')
    expect(init.body).toContain('grant_type=client_credentials')
    expect(init.body).toContain('scope=collab')
  })

  it('issues again once the held token is nearly expired', async () => {
    // Shorter than the renew margin, so the first token is never re-used.
    fetchUpstream.mockResolvedValueOnce(granted('first', 5)).mockResolvedValueOnce(granted('second', 300))
    const { collabAuthHeaders } = await load()

    expect(await collabAuthHeaders()).toEqual({ Authorization: 'Bearer first' })
    expect(await collabAuthHeaders()).toEqual({ Authorization: 'Bearer second' })
  })

  /**
   * A token outlives the process holding it, and Drupal may retire it — the
   * consumer re-provisioned, the keys rotated. That reads as a 401 on an
   * otherwise valid request, and one retry is the whole answer.
   */
  it('issues a fresh token when the held one is refused, and retries once', async () => {
    fetchUpstream.mockResolvedValueOnce(granted('stale')).mockResolvedValueOnce(granted('fresh'))
    const { asCollabServer } = await load()

    const seen: string[] = []
    const answer = await asCollabServer(async (auth) => {
      seen.push(auth.Authorization!)
      if (seen.length === 1) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
      return 'landed'
    })

    expect(answer).toBe('landed')
    expect(seen).toEqual(['Bearer stale', 'Bearer fresh'])
  })

  it('does not retry, or discard the token, on anything but a 401', async () => {
    fetchUpstream.mockResolvedValue(granted('held'))
    const { asCollabServer } = await load()

    let attempts = 0
    await expect(asCollabServer(async () => {
      attempts++
      throw Object.assign(new Error('Conflict'), { statusCode: 409 })
    })).rejects.toThrow('Conflict')
    expect(attempts).toBe(1)
    expect(fetchUpstream).toHaveBeenCalledTimes(1)
  })

  /**
   * A failed token request must not be cached: one blip would otherwise lock the server
   * out for the whole lifetime of a token it never got.
   */
  it('does not hold on to a token request that failed', async () => {
    fetchUpstream
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce(granted('after the blip'))
    const { collabAuthHeaders } = await load()

    expect(await collabAuthHeaders()).toEqual({})
    expect(await collabAuthHeaders()).toEqual({ Authorization: 'Bearer after the blip' })
  })

  it('has no identity, and asks for none, without credentials', async () => {
    delete process.env.OKB_COLLAB_CLIENT_ID
    delete process.env.OKB_COLLAB_CLIENT_SECRET
    const { collabAuthHeaders, collabIdentityConfigured } = await load()

    expect(collabIdentityConfigured()).toBe(false)
    expect(await collabAuthHeaders()).toEqual({})
    expect(fetchUpstream).not.toHaveBeenCalled()
  })
})
