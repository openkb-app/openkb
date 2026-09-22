import { describe, it, expect, vi, afterEach } from 'vitest'
import { ref, watch } from 'vue'
import { useModerationStatus } from './useModerationStatus'
import type { ModerationStatus } from '#shared/utils/moderation'

/**
 * Who requests the moderation status, and when.
 *
 * Nuxt's auto-imports are stubbed with minimal equivalents. The `onMounted`
 * stub keeps the callback, so each test controls when the page mounts.
 */

const STANDING = { nid: 7, moderated: true, state: 'draft' } as unknown as ModerationStatus

let mount: (() => void) | undefined

const toasts: Array<{ title?: string }> = []

function stubNuxt(answer: unknown = STANDING) {
  const requests: string[] = []
  toasts.length = 0
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('watch', watch)
  vi.stubGlobal('onMounted', (fn: () => void) => { mount = fn })
  vi.stubGlobal('useToast', () => ({ add: (toast: { title?: string }) => { toasts.push(toast) } }))
  vi.stubGlobal('console', { ...console, error: () => {} })
  vi.stubGlobal('useRequestFetch', () => async (url: string) => {
    requests.push(url)
    if (answer instanceof Error) throw answer
    return answer
  })
  return requests
}

/** What `$fetch` rejects with when Drupal refuses a write — h3's nesting. */
function refusal(statusCode: number, data: unknown): Error {
  return Object.assign(new Error(`Request failed (${statusCode})`), { statusCode, data })
}

describe('useModerationStatus', () => {
  afterEach(() => {
    mount = undefined
    vi.unstubAllGlobals()
  })

  it('asks nobody when the session may not edit', async () => {
    const requests = stubNuxt()
    const { status } = useModerationStatus(ref(7), ref(false))

    mount!()
    await Promise.resolve()

    expect(requests).toEqual([])
    expect(status.value).toBeNull()
  })

  it('asks once the page is mounted, and adopts the answer', async () => {
    const requests = stubNuxt()
    const { status } = useModerationStatus(ref(7), ref(true))

    // No request before mount.
    expect(requests).toEqual([])
    mount!()
    await Promise.resolve()

    expect(requests).toEqual(['/api/drupal/openkb/node/7/moderation'])
    expect(status.value).toEqual(STANDING)
  })

  it('adopts the standing a publish answers with, without asking again', async () => {
    const published = { ...STANDING, state: 'published' }
    const requests = stubNuxt({ status: published })
    const { status, publish } = useModerationStatus(ref(7), ref(true))

    expect(await publish()).toBe(true)

    expect(requests).toEqual(['/api/node/7/publish'])
    expect(status.value).toEqual(published)
    expect(toasts[0]).toMatchObject({ title: 'Published' })
  })

  it('reads a structural 422 as a hold, carrying Drupal\'s sentence', async () => {
    // No block is named — an id-less body has no review lane — so the whole
    // answer is Drupal's own sentence, and it is a state, not an error.
    const detail = 'Publishing is blocked: the body must consist of identified blocks.'
    const errors: string[] = []
    stubNuxt(refusal(422, { statusMessage: detail, data: { violations: [{ detail }] } }))
    vi.stubGlobal('console', { ...console, error: (...args: unknown[]) => { errors.push(String(args[0])) } })
    const { publish, publishBlockers } = useModerationStatus(ref(7), ref(true))

    expect(await publish()).toBe(false)
    expect(toasts[0]).toMatchObject({ title: 'Publishing is on hold', description: detail })
    expect(publishBlockers.value).toEqual([])
    // The re-read after the refusal runs against the same stub and logs its
    // own line; what must not be there is the publish reported as a failure.
    expect(errors.filter(e => e.includes('publish failed'))).toEqual([])
  })

  it('still reads a refused revert as the failure it is', async () => {
    stubNuxt(refusal(409, { statusMessage: 'External change detected — reload before reverting.' }))
    const { revertToPublished } = useModerationStatus(ref(7), ref(true))

    expect(await revertToPublished()).toBe(false)
    expect(toasts[0]).toMatchObject({ title: 'Revert failed' })
  })
})
