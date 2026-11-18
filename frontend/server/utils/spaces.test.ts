import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  canCreateSpace,
  canManageSpace,
  createSpace,
  findSpaceBySlug,
  indexUsers,
  listSpaces,
  loadSpace,
  rosterOf,
  spacePatchBody,
  writeOutline,
  writeSpace,
} from './spaces'
import { SPACE_CREATE_PERMISSION, USER_INVITE_PERMISSION } from '#shared/utils/kb-spaces'
import { makeEvent, stubFetch } from '../test-support/h3'

/**
 * Pins the space/roster contract the members UI depends on: rosters resolve
 * from the JSON:API `included` block, a reference to a user the session may
 * not see disappears instead of rendering blank, `canManage` is Drupal's own
 * answer off the space access map, and a roster write replaces both fields
 * wholesale.
 */

function spaceDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: 'space-uuid',
    attributes: {
      label: 'Product & Design',
      path: { alias: '/product-design' },
      drupal_internal__id: 7,
      description: 'Docs.',
      read_access: 'all_users',
    },
    relationships: {
      managers: { data: [{ type: 'user--user', id: 'user-b' }] },
      members: { data: [{ type: 'user--user', id: 'user-a' }] },
      viewers: { data: [] },
    },
    ...overrides,
  }
}

const INCLUDED = [
  { type: 'user--user', id: 'user-a', attributes: { name: 'ada', drupal_internal__uid: 4 } },
  { type: 'user--user', id: 'user-b', attributes: { name: 'bob', display_name: 'Bob B.', drupal_internal__uid: 5 } },
]

/** One answer a stubbed path gives. `offline` rejects, as a dead socket does. */
beforeEach(() => {
  vi.stubGlobal('useRuntimeConfig', () => ({ drupalBaseUrl: 'http://drupal.test/' }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('roster resolution', () => {
  it('resolves each roster field, preferring the display name', () => {
    const users = indexUsers(INCLUDED)
    expect(rosterOf(spaceDoc(), 'members', users)).toEqual([{ id: 'user-a', uid: 4, name: 'ada' }])
    expect(rosterOf(spaceDoc(), 'managers', users)).toEqual([{ id: 'user-b', uid: 5, name: 'Bob B.' }])
  })

  it('drops references whose user the session may not view', () => {
    // Drupal omits inaccessible references from `included`; a blank row would
    // leak that someone is on the roster without saying who.
    const users = indexUsers([INCLUDED[0]!])
    expect(rosterOf(spaceDoc(), 'managers', users)).toEqual([])
  })

  it('treats a roster field with no references as empty', () => {
    const users = indexUsers(INCLUDED)
    expect(rosterOf(spaceDoc({ relationships: {} }), 'members', users)).toEqual([])
  })
})

describe('loadSpace', () => {
  it('carries the slug Drupal computed and answers the full roster', async () => {
    stubFetch({
      '/jsonapi/openkb_space/openkb_space/space-uuid': { body: { data: spaceDoc(), included: INCLUDED } },
      '/openkb/spaces': { body: { spaces: [{ slug: 'product-design', name: 'Product & Design', description: '', access: 'read', moderated: true }] } },
    })
    const space = await loadSpace(makeEvent(), 'space-uuid')
    expect(space).toMatchObject({
      id: 'space-uuid',
      internalId: 7,
      name: 'Product & Design',
      slug: 'product-design',
      description: 'Docs.',
      readAccess: 'all_users',
      canManage: false,
      canInvite: false,
    })
    expect(space.managers.map(m => m.name)).toEqual(['Bob B.'])
    expect(space.members.map(m => m.name)).toEqual(['ada'])
    expect(space.viewers).toEqual([])
  })

  it('offers inviting to a manager who holds the invite permission', async () => {
    const spaces = { body: { spaces: [{ slug: 'product-design', name: 'Product & Design', description: '', access: 'manage', moderated: true }] } }
    const permitted = (invite: boolean) => stubFetch({
      '/jsonapi/openkb_space/openkb_space/space-uuid': { body: { data: spaceDoc(), included: INCLUDED } },
      '/openkb/spaces': spaces,
      '/api/site-info': { body: { 'system.site': { name: 'OpenKB' }, permissions: { [USER_INVITE_PERMISSION]: invite } } },
    })
    permitted(true)
    expect(await loadSpace(makeEvent(), 'space-uuid')).toMatchObject({ canManage: true, canInvite: true })
    permitted(false)
    expect(await loadSpace(makeEvent(), 'space-uuid')).toMatchObject({ canManage: true, canInvite: false })
  })

})

describe('canManageSpace', () => {
  /** The access map Drupal answers, for a caller holding `level` on `slug`. */
  function map(entries: Array<{ slug: string, access: string }>) {
    return {
      body: {
        spaces: entries.map(({ slug, access }) => ({
          slug,
          name: slug,
          description: '',
          access,
          moderated: true,
        })),
      },
    }
  }

  it('reads the level off the access map rather than probing a term form', async () => {
    const calls = stubFetch({ '/openkb/spaces': map([{ slug: 'product-design', access: 'manage' }]) })
    expect(await canManageSpace(makeEvent(), 'product-design')).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://drupal.test/openkb/spaces')
  })

  it('is false where the caller may only write', async () => {
    // The scale is ordered — write is not manage, and a roster PATCH is a
    // manage action.
    stubFetch({ '/openkb/spaces': map([{ slug: 'product-design', access: 'write' }]) })
    expect(await canManageSpace(makeEvent(), 'product-design')).toBe(false)
  })

  it('is false for a space the map does not list', async () => {
    stubFetch({ '/openkb/spaces': map([{ slug: 'other', access: 'manage' }]) })
    expect(await canManageSpace(makeEvent(), 'product-design')).toBe(false)
  })

  it('never asks for an anonymous request', async () => {
    const calls = stubFetch()
    expect(await canManageSpace(makeEvent({}), 'product-design')).toBe(false)
    expect(calls).toEqual([])
  })

  it('fails closed when Drupal will not answer the map', async () => {
    stubFetch({ '/openkb/spaces': { offline: true } })
    expect(await canManageSpace(makeEvent(), 'product-design')).toBe(false)
  })

  it('costs one map read for a whole listing, however many spaces it holds', async () => {
    const calls = stubFetch({
      '/jsonapi/openkb_space/openkb_space?': {
        body: {
          data: [
            spaceDoc(),
            spaceDoc({ id: 'b', attributes: { label: 'Team Wiki', path: { alias: '/team-wiki' }, drupal_internal__id: 8 } }),
            spaceDoc({ id: 'c', attributes: { label: 'General', path: { alias: '/general' }, drupal_internal__id: 9 } }),
          ],
        },
      },
      '/openkb/spaces': map([
        { slug: 'product-design', access: 'manage' },
        { slug: 'team-wiki', access: 'write' },
        { slug: 'general', access: 'read' },
      ]),
    })
    const spaces = await listSpaces(makeEvent(), { withAccess: true })
    expect(spaces.map(space => space.canManage)).toEqual([true, false, false])
    // A manager writes too, and a member writes without managing.
    expect(spaces.map(space => space.canWrite)).toEqual([true, true, false])
    expect(calls.filter(call => call.url.includes('/openkb/spaces'))).toHaveLength(1)
  })

  it('reads no access map when the caller did not ask for one', async () => {
    const calls = stubFetch({ '/jsonapi/openkb_space/openkb_space?': { body: { data: [spaceDoc()] } } })
    const spaces = await listSpaces(makeEvent())
    expect(calls.filter(call => call.url.includes('/openkb/spaces'))).toHaveLength(0)
    expect(spaces[0]).not.toHaveProperty('canManage')
  })

  it('answers canWrite false for every space when the map cannot be read', async () => {
    stubFetch({
      '/jsonapi/openkb_space/openkb_space?': { body: { data: [spaceDoc()] } },
      '/openkb/spaces': { status: 503 },
    })
    const spaces = await listSpaces(makeEvent(), { withAccess: true })
    expect(spaces.map(space => space.canWrite)).toEqual([false])
  })
})

describe('listSpaces paging', () => {
  it('follows next to the end, so a space past the page limit still lists', async () => {
    // JSON:API clamps page[limit] to 50. A space dropped here is one the
    // chrome cannot put in context: no roster nav, no create CTA.
    const page = (start: number, count: number) => Array.from({ length: count }, (_, i) => spaceDoc({
      id: `t${start + i}`,
      attributes: { label: `Space ${start + i}`, path: { alias: `/space-${start + i}` }, drupal_internal__id: start + i },
    }))
    const calls = stubFetch({
      '/jsonapi/openkb_space/openkb_space?': [
        { body: { data: page(0, 50), links: { next: { href: 'http://drupal.test/jsonapi/openkb_space/openkb_space?page%5Boffset%5D=50' } } } },
        { body: { data: page(50, 1) } },
      ],
    })

    const listed = await listSpaces(makeEvent())
    expect(listed).toHaveLength(51)
    expect(listed.at(-1)).toMatchObject({ id: 't50', name: 'Space 50' })
    expect(calls).toHaveLength(2)
  })

  it('stops on an empty page instead of following next forever', async () => {
    // Drupal answers `next` on the last full page too, so the empty one after
    // it is the only end marker.
    const calls = stubFetch({
      '/jsonapi/openkb_space/openkb_space?': [
        { body: { data: [spaceDoc()], links: { next: { href: 'http://drupal.test/jsonapi/openkb_space/openkb_space?page%5Boffset%5D=50' } } } },
        { body: { data: [], links: { next: { href: 'http://drupal.test/jsonapi/openkb_space/openkb_space?page%5Boffset%5D=100' } } } },
      ],
    })

    expect(await listSpaces(makeEvent())).toHaveLength(1)
    expect(calls).toHaveLength(2)
  })
})

describe('findSpaceBySlug', () => {
  it('matches the slug Drupal computed, which is the space alias', async () => {
    stubFetch({
      '/jsonapi/openkb_space/openkb_space?': { body: { data: [spaceDoc()] } },
    })
    expect(await findSpaceBySlug(makeEvent(), 'product-design')).toMatchObject({ id: 'space-uuid' })
    expect(await findSpaceBySlug(makeEvent(), 'engineering')).toBeNull()
  })
})

describe('spacePatchBody', () => {
  it('replaces every roster field in one PATCH', () => {
    expect(spacePatchBody('space-uuid', { managers: ['user-c'], members: ['user-a'], viewers: ['user-b'] })).toEqual({
      data: {
        type: 'openkb_space--openkb_space',
        id: 'space-uuid',
        relationships: {
          managers: { data: [{ type: 'user--user', id: 'user-c' }] },
          members: { data: [{ type: 'user--user', id: 'user-a' }] },
          viewers: { data: [{ type: 'user--user', id: 'user-b' }] },
        },
      },
    })
  })

  it('clears a roster with an empty array, not a missing key', () => {
    const body = spacePatchBody('space-uuid', { members: [], managers: ['user-b'] })
    expect((body.data as { relationships: Record<string, unknown> }).relationships.members).toEqual({ data: [] })
  })

  it('writes read access on its own, leaving the roster untouched', () => {
    // A read-access flip must not rewrite the roster: whoever toggles it is not
    // necessarily holding the current member list.
    expect(spacePatchBody('space-uuid', { readAccess: 'members_only' })).toEqual({
      data: {
        type: 'openkb_space--openkb_space',
        id: 'space-uuid',
        attributes: { read_access: 'members_only' },
      },
    })
  })

  it('sends moderation off — the falsy value the whole toggle exists for', () => {
    // A truthiness check here would make the control one-way: turning
    // moderation on would save and turning it off would send an empty body.
    expect(spacePatchBody('space-uuid', { moderation: false })).toEqual({
      data: {
        type: 'openkb_space--openkb_space',
        id: 'space-uuid',
        attributes: { field_moderation: false },
      },
    })
  })

  it('writes an emptied description — a cleared field is a change', () => {
    expect(spacePatchBody('space-uuid', { description: '' })).toEqual({
      data: {
        type: 'openkb_space--openkb_space',
        id: 'space-uuid',
        attributes: { description: '' },
      },
    })
  })

  it('carries read access and moderation in one attributes object', () => {
    expect(spacePatchBody('space-uuid', { readAccess: 'members_only', moderation: true })).toEqual({
      data: {
        type: 'openkb_space--openkb_space',
        id: 'space-uuid',
        attributes: { read_access: 'members_only', field_moderation: true },
      },
    })
  })

  it('sends the agent-review flag off, the same way the moderation one goes', () => {
    expect(spacePatchBody('space-uuid', { agentReview: false })).toEqual({
      data: {
        type: 'openkb_space--openkb_space',
        id: 'space-uuid',
        attributes: { field_agent_review: false },
      },
    })
  })
})

describe('writeSpace', () => {
  it('PATCHes the term and re-reads it', async () => {
    const calls = stubFetch({
      '/jsonapi/openkb_space/openkb_space/space-uuid': { body: { data: spaceDoc(), included: INCLUDED } },
      '/openkb/spaces': { body: { spaces: [{ slug: 'product-design', name: 'Product & Design', description: '', access: 'manage', moderated: true }] } },
    })
    const settings = { managers: ['user-b'], members: ['user-a'], viewers: [] }
    const space = await writeSpace(makeEvent(), 'space-uuid', settings)
    const patch = calls.find(c => c.init.method === 'PATCH')!
    expect(JSON.parse(String(patch.init.body))).toEqual(spacePatchBody('space-uuid', settings))
    expect(space.canManage).toBe(true)
  })
})

describe('read access', () => {
  it('reads a space with no read-access value as members-only', async () => {
    // The strict default: an unset field is never treated as readable by
    // everyone, the same way Drupal reads it.
    stubFetch({
      '/jsonapi/openkb_space/openkb_space/space-uuid': {
        body: {
          data: spaceDoc({ attributes: { label: 'Unset', drupal_internal__id: 7 } }),
          included: INCLUDED,
        },
      },
    })
    expect((await loadSpace(makeEvent(), 'space-uuid')).readAccess).toBe('members_only')
  })
})

describe('moderation', () => {
  it('reads a space with no moderation value as moderated', async () => {
    // Same strict default as read access, and for the same reason: a space
    // whose flag was never written must not silently skip the review.
    stubFetch({
      '/jsonapi/openkb_space/openkb_space/space-uuid': {
        body: {
          data: spaceDoc({ attributes: { label: 'Unset', drupal_internal__id: 7 } }),
          included: INCLUDED,
        },
      },
    })
    expect((await loadSpace(makeEvent(), 'space-uuid')).moderation).toBe(true)
  })

  it('reads an explicit false as unmoderated', async () => {
    stubFetch({
      '/jsonapi/openkb_space/openkb_space/space-uuid': {
        body: {
          data: spaceDoc({ attributes: { label: 'Wiki', drupal_internal__id: 7, field_moderation: false } }),
          included: INCLUDED,
        },
      },
    })
    expect((await loadSpace(makeEvent(), 'space-uuid')).moderation).toBe(false)
  })
})

describe('agent review', () => {
  it('reads a space with no agent-review value as asking for the sign-off', async () => {
    stubFetch({
      '/jsonapi/openkb_space/openkb_space/space-uuid': {
        body: {
          data: spaceDoc({ attributes: { label: 'Unset', drupal_internal__id: 7 } }),
          included: INCLUDED,
        },
      },
    })
    expect((await loadSpace(makeEvent(), 'space-uuid')).agentReview).toBe(true)
  })

  it('reads an explicit false as asking for nothing extra', async () => {
    stubFetch({
      '/jsonapi/openkb_space/openkb_space/space-uuid': {
        body: {
          data: spaceDoc({ attributes: { label: 'Open', drupal_internal__id: 7, field_agent_review: false } }),
          included: INCLUDED,
        },
      },
    })
    expect((await loadSpace(makeEvent(), 'space-uuid')).agentReview).toBe(false)
  })
})

describe('the space outline', () => {
  const OUTLINE = [{ id: 'page-a', children: [{ id: 'page-b', children: [] }] }]

  it('parses the stored tree off the space', async () => {
    stubFetch({
      '/jsonapi/openkb_space/openkb_space?': {
        body: {
          data: [spaceDoc({
            attributes: {
              label: 'Product & Design',
              drupal_internal__id: 7,
              outline: '[{"id":"page-a","children":[{"id":"page-b"}]}]',
            },
          })],
        },
      },
    })
    const [listed] = await listSpaces(makeEvent())
    expect(listed!.outline).toEqual(OUTLINE)
  })

  it('reads a space with no tree yet as no structure, not as an error', async () => {
    stubFetch({ '/jsonapi/openkb_space/openkb_space?': { body: { data: [spaceDoc()] } } })
    const [space] = await listSpaces(makeEvent())
    expect(space!.outline).toEqual([])
  })

  it('answers management access per space when asked for it', async () => {
    // What the sidebar needs before any drag starts.
    stubFetch({
      '/jsonapi/openkb_space/openkb_space?': { body: { data: [spaceDoc()] } },
      '/openkb/spaces': { body: { spaces: [{ slug: 'product-design', name: 'Product & Design', description: '', access: 'manage', moderated: true }] } },
    })
    const [space] = await listSpaces(makeEvent(), { withAccess: true })
    expect(space!.canManage).toBe(true)
  })

  it('costs one Drupal read whatever the size of the knowledge base', async () => {
    // One request per space would open the whole knowledge base on Drupal in
    // one burst, on every SSR document that draws the sidebar.
    const spaces = Array.from({ length: 23 }, (_, index) => spaceDoc({
      id: `term-${index}`,
      attributes: { label: `Space ${index}`, path: { alias: `/space-${index}` }, drupal_internal__id: index + 1 },
    }))
    const calls = stubFetch({
      '/jsonapi/openkb_space/openkb_space?': { body: { data: spaces } },
      '/openkb/spaces': {
        body: {
          spaces: spaces.map((_, index) => ({
            slug: `space-${index}`,
            name: `Space ${index}`,
            description: '',
            access: 'manage',
            moderated: true,
          })),
        },
      },
    })

    const listed = await listSpaces(makeEvent(), { withAccess: true })
    expect(listed).toHaveLength(23)
    expect(listed.every(space => space.canManage)).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('writes the tree through the outline route, naming the tree it replaces', async () => {
    const calls = stubFetch({
      '/openkb/space/7/outline': { body: { outline: [{ id: 'page-a' }] } },
    })
    const stored = await writeOutline(makeEvent(), 7, OUTLINE, [{ id: 'page-a', children: [] }])
    expect(stored).toEqual([{ id: 'page-a', children: [] }])

    const writes = calls.filter(c => c.init.method === 'PUT')
    expect(writes).toHaveLength(1)
    expect(writes[0]!.url).toContain('/openkb/space/7/outline')
    expect(JSON.parse(String(writes[0]!.init.body))).toEqual({
      outline: OUTLINE,
      expect: [{ id: 'page-a', children: [] }],
    })
  })

  it('touches the space and nothing else — no page is saved by a move', async () => {
    const calls = stubFetch({
      '/openkb/space/7/outline': { body: { outline: [] } },
    })
    await writeOutline(makeEvent(), 7, OUTLINE, [])
    expect(calls.some(c => c.url.includes('/jsonapi/node/'))).toBe(false)
    expect(calls.some(c => c.url.includes('/jsonapi/openkb_space/'))).toBe(false)
  })
})

describe('canCreateSpace', () => {
  const siteInfo = (permissions: Record<string, boolean>) =>
    stubFetch({ '/api/site-info': { body: { 'system.site': { name: 'OpenKB' }, permissions } } })

  it('reads the permission answer off site-info, rendering no page', async () => {
    const calls = siteInfo({ [SPACE_CREATE_PERMISSION]: true })
    expect(await canCreateSpace(makeEvent())).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://drupal.test/api/site-info?_format=json')
    expect((calls[0]!.init.method ?? 'GET')).toBe('GET')
    expect(calls.some(c => c.url.includes('/ce-api/'))).toBe(false)
  })

  it('is false when the session does not hold the permission', async () => {
    siteInfo({ [SPACE_CREATE_PERMISSION]: false })
    expect(await canCreateSpace(makeEvent())).toBe(false)
  })

  it('is false when the permission is missing from the answer', async () => {
    siteInfo({})
    expect(await canCreateSpace(makeEvent())).toBe(false)
  })

  it('is false when the read fails, so a broken response never draws the CTA', async () => {
    stubFetch({ '/api/site-info': { status: 503 } })
    expect(await canCreateSpace(makeEvent())).toBe(false)
  })

  it('asks nothing for a session with no credential to ask with', async () => {
    const calls = siteInfo({ [SPACE_CREATE_PERMISSION]: true })
    expect(await canCreateSpace(makeEvent({}))).toBe(false)
    expect(calls).toHaveLength(0)
  })
})

describe('createSpace', () => {
  it('POSTs the space and answers with the id and the saved slug, no re-fetch', async () => {
    const calls = stubFetch({
      '/jsonapi/openkb_space/openkb_space': { status: 201, body: { data: spaceDoc() } },
    })
    const created = await createSpace(makeEvent(), {
      name: 'Product & Design',
      description: 'Docs.',
      readAccess: 'all_users',
      moderation: false,
      agentReview: false,
    })

    const post = calls.find(c => c.init.method === 'POST')!
    expect(JSON.parse(String(post.init.body))).toEqual({
      data: {
        type: 'openkb_space--openkb_space',
        attributes: {
          label: 'Product & Design',
          description: 'Docs.',
          read_access: 'all_users',
          field_moderation: false,
          field_agent_review: false,
        },
      },
    })
    // The slug comes off the POST response — there is exactly one POST and no
    // follow-up GET of the created space.
    expect(created).toEqual({ id: 'space-uuid', slug: 'product-design' })
    expect(calls.filter(c => c.init.method === 'POST')).toHaveLength(1)
    expect(calls.some(c => c.url.includes('/jsonapi/openkb_space/openkb_space/space-uuid'))).toBe(false)
  })

  it('sends only what the surface set — the rest stays Drupal\'s defaults', async () => {
    const calls = stubFetch({
      '/jsonapi/openkb_space/openkb_space': { status: 201, body: { data: spaceDoc() } },
    })
    await createSpace(makeEvent(), { name: 'Ops' })
    const post = calls.find(c => c.init.method === 'POST')!
    // No description, no read-access, no moderation keys — members-only +
    // moderated are the field defaults, and naming them here would be a second source.
    expect(JSON.parse(String(post.init.body)).data.attributes).toEqual({ label: 'Ops' })
  })

  it('rejects a 2xx that carries no space as an upstream failure', async () => {
    stubFetch({ '/jsonapi/openkb_space/openkb_space': { status: 201, body: {} } })
    await expect(createSpace(makeEvent(), { name: 'Ops' })).rejects.toMatchObject({ statusCode: 503 })
  })

  it('rejects a created space that carries no slug the same way', async () => {
    stubFetch({
      '/jsonapi/openkb_space/openkb_space': { status: 201, body: { data: { id: 'space-uuid', attributes: {} } } },
    })
    await expect(createSpace(makeEvent(), { name: 'Ops' })).rejects.toMatchObject({ statusCode: 503 })
  })
})
