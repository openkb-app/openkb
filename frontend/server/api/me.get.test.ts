import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { H3Event } from 'h3'
import handler from './me.get'

/**
 * /api/me is the one identity source for the chrome and the collab awareness
 * layer — these tests pin its resolution contract: JSON:API root
 * `meta.links.me` → user resource, the picture and the capabilities that ride
 * along, anonymous as a valid 200 answer, and upstream failures passing
 * through as errors instead of being misread as "anonymous".
 */

const drupalFetch = vi.fn()
const sitePermissions = vi.fn()
const canCreateSpace = vi.fn()

vi.mock('../utils/drupal', () => ({
  drupalFetch: (...a: unknown[]) => drupalFetch(...a),
  sitePermissions: (...a: unknown[]) => sitePermissions(...a),
  publicDrupalBaseUrl: () => 'http://drupal.test',
}))
vi.mock('../utils/spaces', () => ({
  canCreateSpace: (...a: unknown[]) => canCreateSpace(...a),
}))

const event = {} as H3Event

const ANONYMOUS = { name: null, uid: null, picture: null, isAdmin: false, canCreateSpace: false, canCreatePage: false }

function callMe() {
  return handler(event)
}

/** The JSON:API root + user pair a signed-in session resolves through. */
function stubSession(attributes: Record<string, unknown>, included?: unknown[]) {
  drupalFetch
    .mockResolvedValueOnce({ meta: { links: { me: { meta: { id: 'uuid-1' } } } } })
    .mockResolvedValueOnce({ data: { attributes }, included })
}

describe('GET /api/me', () => {
  beforeEach(() => {
    drupalFetch.mockReset()
    sitePermissions.mockReset().mockResolvedValue({})
    canCreateSpace.mockReset().mockResolvedValue(false)
  })

  it('resolves the session user via meta.links.me and returns name + uid', async () => {
    stubSession({ name: 'admin', drupal_internal__uid: 1 })
    await expect(callMe()).resolves.toEqual({ ...ANONYMOUS, name: 'admin', uid: 1 })
    expect(String(drupalFetch.mock.calls[1]?.[1])).toContain('/jsonapi/user/user/uuid-1')
  })

  it('prefers display_name over the account name', async () => {
    stubSession({ name: 'jdoe', display_name: 'Jane Doe', drupal_internal__uid: 7 })
    await expect(callMe()).resolves.toMatchObject({ name: 'Jane Doe', uid: 7 })
  })

  it('answers an anonymous session with nulls, not an error', async () => {
    // Drupal's JSON:API root carries no `me` link for anonymous.
    drupalFetch.mockResolvedValueOnce({})
    await expect(callMe()).resolves.toEqual(ANONYMOUS)
    expect(drupalFetch).toHaveBeenCalledTimes(1)
    // No probe for a session that has no identity to probe with.
    expect(sitePermissions).not.toHaveBeenCalled()
    expect(canCreateSpace).not.toHaveBeenCalled()
  })

  it('absolutises the included user_picture onto the browser-facing origin', async () => {
    stubSession(
      { name: 'jdoe', drupal_internal__uid: 7 },
      [{ type: 'file--file', attributes: { uri: { url: '/sites/default/files/pictures/jdoe.png' } } }],
    )
    await expect(callMe()).resolves.toMatchObject({
      picture: 'http://drupal.test/sites/default/files/pictures/jdoe.png',
    })
    // The picture is asked for in the same request as the name.
    expect(String(drupalFetch.mock.calls[1]?.[1])).toContain('include=user_picture')
  })

  it('reports no picture when the account has none', async () => {
    stubSession({ name: 'jdoe', drupal_internal__uid: 7 })
    await expect(callMe()).resolves.toMatchObject({ picture: null })
  })

  it('derives the admin flag from the permission read, rendering no page', async () => {
    stubSession({ name: 'admin', drupal_internal__uid: 1 })
    sitePermissions.mockResolvedValue({ 'access administration pages': true })
    await expect(callMe()).resolves.toMatchObject({ isAdmin: true })
    expect(sitePermissions).toHaveBeenCalledTimes(1)
    expect(sitePermissions).toHaveBeenCalledWith(event)
  })

  it('reports a plain editor as no admin', async () => {
    stubSession({ name: 'editor1', drupal_internal__uid: 3 })
    sitePermissions.mockResolvedValue({ 'access administration pages': false })
    await expect(callMe()).resolves.toMatchObject({ isAdmin: false })
  })

  it('reports no admin when the permission read answered nothing', async () => {
    stubSession({ name: 'editor1', drupal_internal__uid: 3 })
    sitePermissions.mockResolvedValue({})
    await expect(callMe()).resolves.toMatchObject({ isAdmin: false })
  })

  it('reports the space-creation permission Drupal answers for the session', async () => {
    stubSession({ name: 'editor', drupal_internal__uid: 4 })
    canCreateSpace.mockResolvedValue(true)
    await expect(callMe()).resolves.toMatchObject({ canCreateSpace: true })
    // The session's own carrier is the whole address; no uid to pass.
    expect(canCreateSpace).toHaveBeenCalledWith(event)
  })

  it('reports the page-creation permission off the same site-info read', async () => {
    // The site-wide half of the add-page CTA. Which spaces it may land in is
    // `canWrite` on /api/spaces, not asked here.
    stubSession({ name: 'editor1', drupal_internal__uid: 3 })
    sitePermissions.mockResolvedValue({ 'create kb_page content': true })
    await expect(callMe()).resolves.toMatchObject({ canCreatePage: true, isAdmin: false })
  })

  it('reports no page creation when the permission read answered nothing', async () => {
    stubSession({ name: 'editor1', drupal_internal__uid: 3 })
    sitePermissions.mockResolvedValue({})
    await expect(callMe()).resolves.toMatchObject({ canCreatePage: false })
  })

  it('passes an upstream failure through instead of reporting anonymous', async () => {
    drupalFetch.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { statusCode: 503 }))
    await expect(callMe()).rejects.toMatchObject({ statusCode: 503 })
  })
})
