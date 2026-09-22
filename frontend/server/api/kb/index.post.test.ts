import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { H3Event } from 'h3'

/**
 * `POST /api/kb` is the create surface's transport: it validates what the dialog
 * sent, resolves the context space and hands the page to Drupal (pathauto
 * mints the alias on save). What it must never do is invent a space or let an
 * unauthenticated caller through — everything else (field access, validation)
 * is Drupal's.
 */

const createKbPage = vi.fn()
vi.mock('../../utils/drupal', () => ({
  createKbPage: (...a: unknown[]) => createKbPage(...a),
}))

const resolveSpaceId = vi.fn()
vi.mock('../../utils/spaces', () => ({
  resolveSpaceId: (...a: unknown[]) => resolveSpaceId(...a),
}))

const readBody = vi.fn()
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('h3')>()
  return { ...actual, readBody: (...a: unknown[]) => readBody(...a) }
})

const handler = (await import('./index.post')).default as unknown as
  (event: H3Event) => Promise<unknown>

const SPACE_UUID = '7f0aa5e7-3c5b-46cb-9002-c7a65aff9857'

function event(headers: Record<string, string> = { cookie: 'SESS=1' }): H3Event {
  return { node: { req: { headers } } } as unknown as H3Event
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

describe('POST /api/kb', () => {
  beforeEach(() => {
    createKbPage.mockReset()
    resolveSpaceId.mockReset().mockResolvedValue(SPACE_UUID)
    readBody.mockReset()
  })

  it('creates a draft in the context space and seeds a heading', async () => {
    readBody.mockResolvedValue({ title: '  Getting Started ', space: 'engineering' })
    createKbPage.mockResolvedValue({
      nid: 42,
      uuid: 'page-uuid',
      title: 'Getting Started',
      path: '/engineering/getting-started',
    })

    const result = await handler(event())

    expect(resolveSpaceId).toHaveBeenCalledWith(expect.anything(), 'engineering')
    expect(createKbPage).toHaveBeenCalledWith(expect.anything(), {
      title: 'Getting Started',
      spaceId: SPACE_UUID,
      // The title heading carries the lead section's block id, the anchor a
      // citation of that section lands on.
      body: expect.stringMatching(/^# Getting Started \{#b-[0-9a-f]{8}\}\n\n$/),
    })
    expect(result).toMatchObject({ nid: 42, path: '/engineering/getting-started' })
  })

  it('requires a session', async () => {
    readBody.mockResolvedValue({ title: 'Anonymous page', space: SPACE_UUID })
    expect(await statusOf(handler(event({})))).toBe(401)
    expect(createKbPage).not.toHaveBeenCalled()
  })

  it('requires a title and a space', async () => {
    readBody.mockResolvedValue({ title: '   ', space: SPACE_UUID })
    expect(await statusOf(handler(event()))).toBe(400)

    readBody.mockResolvedValue({ title: 'No space in sight' })
    expect(await statusOf(handler(event()))).toBe(400)

    expect(createKbPage).not.toHaveBeenCalled()
  })
})
