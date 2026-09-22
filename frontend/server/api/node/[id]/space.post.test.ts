import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { H3Event } from 'h3'

/**
 * `POST /api/node/<nid>/space` is a transport onto the Drupal move route: it
 * resolves whichever way the caller named the target space and forwards. The
 * revision semantics of a move live in PageSpaceResource (and its Functional
 * test); what is pinned here is that a slug and a UUID both work and that
 * nothing moves without a session or a target.
 */

const moveKbPageToSpace = vi.fn()
vi.mock('../../../utils/drupal', () => ({
  moveKbPageToSpace: (...a: unknown[]) => moveKbPageToSpace(...a),
}))

const resolveSpaceId = vi.fn()
vi.mock('../../../utils/spaces', () => ({
  resolveSpaceId: (...a: unknown[]) => resolveSpaceId(...a),
}))

const readBody = vi.fn()
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('h3')>()
  return { ...actual, readBody: (...a: unknown[]) => readBody(...a) }
})

const handler = (await import('./space.post')).default as unknown as
  (event: H3Event) => Promise<unknown>

const SPACE_UUID = '7f0aa5e7-3c5b-46cb-9002-c7a65aff9857'

function event(id: string, headers: Record<string, string> = { cookie: 'SESS=1' }): H3Event {
  return {
    context: { params: { id } },
    node: { req: { headers } },
  } as unknown as H3Event
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise
    throw new Error('expected a rejection')
  }
  catch (err) {
    return (err as { statusCode?: number }).statusCode ?? 0
  }
}

describe('POST /api/node/:id/space', () => {
  beforeEach(() => {
    moveKbPageToSpace.mockReset().mockResolvedValue({
      nid: 7,
      space: { id: SPACE_UUID, name: 'Product' },
    })
    resolveSpaceId.mockReset().mockImplementation((_e: unknown, space: string) =>
      Promise.resolve(space === 'product' ? SPACE_UUID : space),
    )
    readBody.mockReset()
  })

  it('moves the page to a space named by slug', async () => {
    readBody.mockResolvedValue({ space: 'product' })
    const result = await handler(event('7'))
    expect(moveKbPageToSpace).toHaveBeenCalledWith(expect.anything(), 7, SPACE_UUID)
    expect(result).toMatchObject({ space: { name: 'Product' } })
  })

  it('moves the page to a space named by UUID', async () => {
    readBody.mockResolvedValue({ space: SPACE_UUID })
    await handler(event('7'))
    expect(moveKbPageToSpace).toHaveBeenCalledWith(expect.anything(), 7, SPACE_UUID)
  })

  it('refuses a bad nid, a missing session and a missing target', async () => {
    readBody.mockResolvedValue({ space: SPACE_UUID })
    expect(await statusOf(handler(event('not-a-nid')))).toBe(400)
    expect(await statusOf(handler(event('7', {})))).toBe(401)

    readBody.mockResolvedValue({})
    expect(await statusOf(handler(event('7')))).toBe(400)

    expect(moveKbPageToSpace).not.toHaveBeenCalled()
  })
})
