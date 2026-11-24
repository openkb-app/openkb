import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { embedFrameSrcPolicy, fetchFileOwnerUids, resolveFileUuids } from './files'

const A = '11111111-2222-4333-8444-555555555555'
const B = '66666666-7777-4888-9999-000000000000'

beforeEach(() => {
  vi.stubGlobal('useRuntimeConfig', () => ({ drupalBaseUrl: 'http://drupal.test', public: {} }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('resolveFileUuids', () => {
  it('asks for each file under the caller\'s carrier and leaves out what it may not read', async () => {
    const fetch = vi.fn(async (url: string) => url.includes(A)
      ? new Response(JSON.stringify({
          data: { id: A, attributes: { filename: 'a.pdf', filesize: 12, filemime: 'application/pdf', created: '2026-10-08T07:00:00+00:00', uri: { url: '/system/files/attachments/a.pdf' } } },
          included: [{ id: 'u', attributes: { display_name: 'editor1' } }],
        }), { status: 200 })
      : new Response('{"errors":[]}', { status: 403 }))
    vi.stubGlobal('fetch', fetch)

    expect(await resolveFileUuids({ Cookie: 'SESS=1' }, [A, B])).toEqual({
      [A]: {
        url: 'http://drupal.test/system/files/attachments/a.pdf',
        name: 'a.pdf',
        size: 12,
        mime: 'application/pdf',
        owner: 'editor1',
        created: '2026-10-08T07:00:00+00:00',
      },
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect((fetch.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ Cookie: 'SESS=1' })
  })

  it('fails on an unreachable backend rather than reporting the file gone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })))
    await expect(resolveFileUuids({}, [A])).rejects.toMatchObject({ statusCode: 503 })
  })
})

describe('fetchFileOwnerUids', () => {
  it('reads each owner under the caller\'s carrier, null for a file it may not download', async () => {
    const fetch = vi.fn(async (url: string, _init?: RequestInit) => url.includes(A)
      ? new Response(JSON.stringify({
          data: { id: A, attributes: { uri: { url: '/system/files/a.pdf' } }, relationships: { uid: { data: { meta: { drupal_internal__target_id: 3 } } } } },
        }), { status: 200 })
      : new Response('{"errors":[]}', { status: 403 }))
    vi.stubGlobal('fetch', fetch)

    expect(await fetchFileOwnerUids({ Authorization: 'Bearer tok' }, [A, B])).toEqual({ [A]: 3, [B]: null })
    const init = fetch.mock.calls[0]![1]
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer tok' })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('fails closed on an unreachable backend', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })))
    await expect(fetchFileOwnerUids({}, [A])).rejects.toMatchObject({ statusCode: 503 })
  })
})

describe('embedFrameSrcPolicy', () => {
  it('allows frames from the public Drupal origin only', () => {
    vi.stubGlobal('useRuntimeConfig', () => ({ drupalBaseUrl: 'http://drupal:8080', public: { drupalBaseUrl: 'https://kb.example.com/sub/' } }))
    expect(embedFrameSrcPolicy()).toBe('frame-src https://kb.example.com')
  })

  it('falls back to the server-side Drupal origin', () => {
    expect(embedFrameSrcPolicy()).toBe('frame-src http://drupal.test')
  })

  it('allows the Nuxt DevTools frame in dev', () => {
    expect(embedFrameSrcPolicy(true)).toBe('frame-src \'self\' http://drupal.test')
  })
})
