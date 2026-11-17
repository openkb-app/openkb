import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { H3Event } from 'h3'
import handler from './me.get'

/**
 * /api/me is the one identity source for the chrome and the collab awareness
 * layer — these tests pin its resolution contract: acting identity → user
 * resource, the picture and the capabilities that ride
 * along, anonymous as a valid 200 answer, and upstream failures passing
 * through as errors instead of being misread as "anonymous".
 */

const drupalFetch = vi.fn()
const resolveActor = vi.fn()
const sitePermissions = vi.fn()
const canCreateSpace = vi.fn()

vi.mock('../utils/drupal', () => ({
  drupalFetch: (...a: unknown[]) => drupalFetch(...a),
  sitePermissions: (...a: unknown[]) => sitePermissions(...a),
  publicDrupalBaseUrl: () => 'http://drupal.test',
}))
vi.mock('../utils/actor', () => ({
  resolveActor: (...a: unknown[]) => resolveActor(...a),
}))
vi.mock('../utils/spaces', () => ({
  canCreateSpace: (...a: unknown[]) => canCreateSpace(...a),
}))

const event = {} as H3Event

const ANONYMOUS = { name: null, uid: null, picture: null, isAdmin: false, canCreateSpace: false, canCreatePage: false, canChat: false }

function callMe() {
  return handler(event)
}

/** The identity + user resource a signed-in session resolves through. */
function stubSession(uid: number, attributes: Record<string, unknown>, included?: unknown[]) {
  resolveActor.mockResolvedValueOnce({ type: 'human', uid, name: attributes.name, via: null })
  drupalFetch.mockResolvedValueOnce({ data: [{ attributes }], included })
}

describe('GET /api/me', () => {
  beforeEach(() => {
    drupalFetch.mockReset()
    resolveActor.mockReset()
    sitePermissions.mockReset().mockResolvedValue({})
    canCreateSpace.mockReset().mockResolvedValue(false)
  })

  it('resolves the session user via the acting identity and returns name + uid', async () => {
    stubSession(1, { name: 'admin' })
    await expect(callMe()).resolves.toEqual({ ...ANONYMOUS, name: 'admin', uid: 1 })
    expect(String(drupalFetch.mock.calls[0]?.[1])).toContain('/jsonapi/user/user?filter')
    expect(decodeURIComponent(String(drupalFetch.mock.calls[0]?.[1]))).toContain('[drupal_internal__uid]=1')
  })

  it('prefers display_name over the account name', async () => {
    stubSession(7, { name: 'jdoe', display_name: 'Jane Doe' })
    await expect(callMe()).resolves.toMatchObject({ name: 'Jane Doe', uid: 7 })
  })

  it('answers an anonymous session with nulls, not an error', async () => {
    resolveActor.mockResolvedValueOnce({ type: 'anonymous', uid: null, name: null, via: null })
    await expect(callMe()).resolves.toEqual(ANONYMOUS)
    // JSON:API is closed to anonymous: not asked.
    expect(drupalFetch).not.toHaveBeenCalled()
    // No probe for a session that has no identity to probe with.
    expect(sitePermissions).not.toHaveBeenCalled()
    expect(canCreateSpace).not.toHaveBeenCalled()
  })

  it('absolutises the included user_picture onto the browser-facing origin', async () => {
    stubSession(
      7,
      { name: 'jdoe' },
      [{ type: 'file--file', attributes: { uri: { url: '/sites/default/files/pictures/jdoe.png' } } }],
    )
    await expect(callMe()).resolves.toMatchObject({
      picture: 'http://drupal.test/sites/default/files/pictures/jdoe.png',
    })
    // The picture is asked for in the same request as the name.
    expect(String(drupalFetch.mock.calls[0]?.[1])).toContain('include=user_picture')
  })

  it('reports no picture when the account has none', async () => {
    stubSession(7, { name: 'jdoe' })
    await expect(callMe()).resolves.toMatchObject({ picture: null })
  })

  it('derives the admin flag from the permission read, rendering no page', async () => {
    stubSession(1, { name: 'admin' })
    sitePermissions.mockResolvedValue({ 'access administration pages': true })
    await expect(callMe()).resolves.toMatchObject({ isAdmin: true })
    expect(sitePermissions).toHaveBeenCalledTimes(1)
    expect(sitePermissions).toHaveBeenCalledWith(event)
  })

  it('reports a plain editor as no admin', async () => {
    stubSession(3, { name: 'editor1' })
    sitePermissions.mockResolvedValue({ 'access administration pages': false })
    await expect(callMe()).resolves.toMatchObject({ isAdmin: false })
  })

  it('reports no admin when the permission read answered nothing', async () => {
    stubSession(3, { name: 'editor1' })
    sitePermissions.mockResolvedValue({})
    await expect(callMe()).resolves.toMatchObject({ isAdmin: false })
  })

  it('reports the space-creation permission Drupal answers for the session', async () => {
    stubSession(4, { name: 'editor' })
    canCreateSpace.mockResolvedValue(true)
    await expect(callMe()).resolves.toMatchObject({ canCreateSpace: true })
    // The session's own carrier is the whole address; no uid to pass.
    expect(canCreateSpace).toHaveBeenCalledWith(event)
  })

  it('reports the page-creation permission off the same site-info read', async () => {
    // The site-wide half of the add-page CTA. Which spaces it may land in is
    // `canWrite` on /api/spaces, not asked here.
    stubSession(3, { name: 'editor1' })
    sitePermissions.mockResolvedValue({ 'create kb_page content': true })
    await expect(callMe()).resolves.toMatchObject({ canCreatePage: true, isAdmin: false })
  })

  it('reports no page creation when the permission read answered nothing', async () => {
    stubSession(3, { name: 'editor1' })
    sitePermissions.mockResolvedValue({})
    await expect(callMe()).resolves.toMatchObject({ canCreatePage: false })
  })

  it('lets the assistant act for an account without an administrator role', async () => {
    stubSession(3, { name: 'editor1' })
    await expect(callMe()).resolves.toMatchObject({ canChat: true })
    // The roles are asked for in the same request as the name.
    expect(decodeURIComponent(String(drupalFetch.mock.calls[0]?.[1]))).toContain('include=user_picture,roles')

    stubSession(5, { name: 'siteadmin' }, [{ type: 'user_role--user_role', attributes: { is_admin: false } }])
    await expect(callMe()).resolves.toMatchObject({ canChat: true })
  })

  it('reports no chat for an administrator, who is issued no agent token', async () => {
    stubSession(1, { name: 'admin' })
    await expect(callMe()).resolves.toMatchObject({ canChat: false })

    stubSession(8, { name: 'root' }, [{ type: 'user_role--user_role', attributes: { is_admin: true } }])
    await expect(callMe()).resolves.toMatchObject({ canChat: false })
  })

  it('passes an upstream failure through instead of reporting anonymous', async () => {
    resolveActor.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { statusCode: 503 }))
    await expect(callMe()).rejects.toMatchObject({ statusCode: 503 })
  })
})
