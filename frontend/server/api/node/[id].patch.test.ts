import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { H3Event } from 'h3'

/**
 * What this route does with Drupal's answers. The lookup is the ce-api read,
 * so absent and forbidden are different answers and each is passed on as it
 * came: 403 where the session may not read the page, 404 only where the
 * space hides it.
 */

const fetchCeNode = vi.fn()
const patchKbPageBody = vi.fn()
vi.mock('../../utils/drupal', () => ({
  fetchCeNode: (...a: unknown[]) => fetchCeNode(...a),
  patchKbPageBody: (...a: unknown[]) => patchKbPageBody(...a),
}))
vi.mock('../../utils/actor', () => ({
  forwardedAuthHeaders: () => ({ Cookie: 'SESS=1' }),
}))

const body: Record<string, unknown> = {}
vi.mock('h3', async () => {
  const h3 = await vi.importActual<typeof import('h3')>('h3')
  return { ...h3, readBody: async () => body }
})

const handler = (await import('./[id].patch')).default as unknown as
  (event: H3Event) => Promise<unknown>

function event(id: string, cookie: string | null = 'SESS=1'): H3Event {
  return {
    context: { params: { id } },
    node: { req: { headers: cookie ? { cookie } : {} } },
  } as unknown as H3Event
}

const PAGE = { id: 'u-7', nid: 7, title: 'Runbook', titleHeading: '# Runbook\n\n', changed: 100 }

describe('PATCH /api/node/:id', () => {
  beforeEach(() => {
    for (const key of Object.keys(body)) delete body[key]
    body.body = 'New body.'
    fetchCeNode.mockReset().mockResolvedValue({ page: PAGE })
    patchKbPageBody.mockReset().mockResolvedValue(200)
  })

  it('writes the document and answers with Drupal\'s new changed', async () => {
    await expect(handler(event('7'))).resolves.toEqual({ nid: 7, ok: true, changed: 200 })
    expect(patchKbPageBody.mock.lastCall?.[2]).toMatch(/^# Runbook \{#b-[0-9a-f]{8}\}\n\nNew body\.\n$/)
  })

  it('passes on the refusal of a page this session may not read', async () => {
    fetchCeNode.mockRejectedValue(Object.assign(new Error('Forbidden'), { statusCode: 403 }))

    await expect(handler(event('7'))).rejects.toMatchObject({ statusCode: 403 })
    expect(patchKbPageBody).not.toHaveBeenCalled()
  })

  it('answers 404 only where the space hides the page', async () => {
    fetchCeNode.mockRejectedValue(Object.assign(new Error('Not Found'), { statusCode: 404 }))

    await expect(handler(event('7'))).rejects.toMatchObject({ statusCode: 404 })
  })

  it('refuses a caller with no session before anything is read', async () => {
    await expect(handler(event('7', null))).rejects.toMatchObject({ statusCode: 401 })
    expect(fetchCeNode).not.toHaveBeenCalled()
  })

  it('refuses a write against a revision that has moved', async () => {
    body.expected_changed = 99

    await expect(handler(event('7'))).rejects.toMatchObject({
      statusCode: 409,
      data: { expected: 99, actual: 100 },
    })
    expect(patchKbPageBody).not.toHaveBeenCalled()
  })
})
