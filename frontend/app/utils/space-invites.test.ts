import { describe, it, expect, beforeEach, vi } from 'vitest'
import { inviteToSpaceByEmail, loadSpacePendingInvites } from './space-invites'
import type { KbSpaceDetail } from '#shared/utils/kb-spaces'

/**
 * The invites of a space as Drupal's JSON:API resource: the pending ones of
 * the space and the create document an invite sends.
 */

const SPACE = { id: 'space-uuid', internalId: 4 } as KbSpaceDetail

const fetchMock = vi.fn()
const csrfFetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  csrfFetchMock.mockReset()
  vi.stubGlobal('$fetch', fetchMock)
  vi.stubGlobal('csrfFetch', csrfFetchMock)
})

describe('loadSpacePendingInvites', () => {
  it('lists the space\'s pending invites; the email only where Drupal sends it', async () => {
    fetchMock.mockResolvedValue({ data: [
      { id: 'invite-1', attributes: { mail: 'ada@example.com', role: 'viewer' } },
      { id: 'invite-2', attributes: { role: 'member' } },
    ] })
    expect(await loadSpacePendingInvites(SPACE)).toEqual([
      { id: 'invite-1', mail: 'ada@example.com', role: 'viewer' },
      { id: 'invite-2', mail: null, role: 'member' },
    ])
    const url = new URL(fetchMock.mock.calls[0]![0], 'http://app.test')
    expect(url.pathname).toBe('/api/drupal/jsonapi/openkb_invite/openkb_invite')
    expect(url.searchParams.get('filter[space.meta.drupal_internal__target_id]')).toBe('4')
    expect(url.searchParams.get('filter[pending][condition][path]')).toBe('accepted')
    expect(url.searchParams.get('filter[pending][condition][operator]')).toBe('IS NULL')
  })
})

describe('inviteToSpaceByEmail', () => {
  it('creates the invite onto the space', async () => {
    csrfFetchMock.mockResolvedValue({ data: { id: 'invite-3', attributes: { role: 'viewer' } } })
    await inviteToSpaceByEmail(SPACE, 'ada@example.com', 'viewer')
    const [url, init] = csrfFetchMock.mock.calls[0]!
    expect(url).toBe('/api/drupal/jsonapi/openkb_invite/openkb_invite')
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.api+json' },
      body: {
        data: {
          type: 'openkb_invite--openkb_invite',
          attributes: { mail: 'ada@example.com', role: 'viewer' },
          relationships: { space: { data: { type: 'openkb_space--openkb_space', id: 'space-uuid' } } },
        },
      },
    })
  })
})
