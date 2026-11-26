import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { H3Event } from 'h3'
import { makeEvent } from '../../test-support/h3'

/**
 * `POST /api/spaces` is the add-space dialog's same-origin transport: it trims
 * what the dialog sent and hands everything to Drupal, who decides all of it.
 */

const createSpace = vi.fn()
vi.mock('../../utils/spaces', () => ({
  createSpace: (...a: unknown[]) => createSpace(...a),
}))

const readBody = vi.fn()
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('h3')>()
  return { ...actual, readBody: (...a: unknown[]) => readBody(...a) }
})

const handler = (await import('./index.post')).default as unknown as
  (event: H3Event) => Promise<unknown>

describe('POST /api/spaces', () => {
  beforeEach(() => {
    createSpace.mockReset().mockResolvedValue({ id: 'term-uuid', slug: 'ops' })
    readBody.mockReset()
  })

  it('trims the fields, forwards the policy, and answers with the slug', async () => {
    readBody.mockResolvedValue({
      name: '  Ops ',
      description: ' How we run things. ',
      readAccess: 'all_users',
      moderation: false,
      agentReview: false,
    })
    await expect(handler(makeEvent({ cookie: 'SESS=1' }))).resolves.toEqual({ id: 'term-uuid', slug: 'ops' })
    expect(createSpace).toHaveBeenCalledWith(expect.anything(), {
      name: 'Ops',
      description: 'How we run things.',
      readAccess: 'all_users',
      moderation: false,
      agentReview: false,
    })
  })

  it('sends no description at all when the field was left empty', async () => {
    readBody.mockResolvedValue({ name: 'Ops', description: '   ' })
    await handler(makeEvent({ cookie: 'SESS=1' }))
    expect(createSpace).toHaveBeenCalledWith(expect.anything(), {
      name: 'Ops',
      description: undefined,
      readAccess: undefined,
      moderation: undefined,
      agentReview: undefined,
    })
  })

  it('lets Drupal answer an empty name — this layer does not gate it', async () => {
    // An empty name is a 422 from Drupal (the term name is required); the
    // dialog gates it client-side, and restating it here would be a second rule.
    readBody.mockResolvedValue({ name: '   ' })
    createSpace.mockRejectedValue(Object.assign(new Error('required'), { statusCode: 422 }))
    await expect(handler(makeEvent({ cookie: 'SESS=1' }))).rejects.toMatchObject({ statusCode: 422 })
    expect(createSpace).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: '' }))
  })
})
