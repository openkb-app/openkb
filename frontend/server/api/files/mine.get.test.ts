import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { H3Event } from 'h3'
import handler from './mine.get'

let query: Record<string, string> = {}

vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('h3')>()
  return { ...actual, getQuery: () => query, getHeader: (_e: unknown, name: string) => name === 'cookie' ? 'SESS=1' : undefined }
})

const event = {} as H3Event
const ME = 'e1e11111-1111-4e11-9e11-111111111111'

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

beforeEach(() => {
  vi.stubGlobal('useRuntimeConfig', () => ({ drupalBaseUrl: 'http://drupal.test', public: {} }))
  query = {}
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('GET /api/files/mine', () => {
  it('lists only the caller\'s own files, newest first, images only when asked', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/jsonapi')) return json({ meta: { links: { me: { meta: { id: ME } } } } })
      if (url.includes('/jsonapi/node/')) return json({ data: [] })
      return json({ data: [{ id: 'f1', attributes: { filename: 'a.png', filesize: 3, filemime: 'image/png', created: 'c', uri: { url: '/system/files/images/a.png' } } }] })
    })
    vi.stubGlobal('fetch', fetch)
    query = { images: '1' }

    const { items } = await handler(event)
    expect(items).toEqual([{ id: 'f1', url: 'http://drupal.test/system/files/images/a.png', name: 'a.png', size: 3, mime: 'image/png', owner: null, created: 'c', usedOn: [] }])
    const listed = decodeURIComponent(String(fetch.mock.calls[1]![0]))
    expect(listed).toContain(`filter[uid.id]=${ME}`)
    expect(listed).toContain('image/')
    expect(listed).toContain('sort=-created')
  })

  it('names the readable pages that hold each file', async () => {
    const files = ['f1', 'f2', 'f3'].map(id => ({ id, attributes: { filename: `${id}.pdf`, filesize: 1, filemime: 'application/pdf', created: 'c', uri: { url: `/system/files/${id}.pdf` } } }))
    const ref = (...ids: string[]) => ({ data: ids.map(id => ({ type: 'file--file', id })) })
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/jsonapi')) return json({ meta: { links: { me: { meta: { id: ME } } } } })
      if (decodeURIComponent(url).includes('[path]=field_kb_attachments.id')) {
        return json({ data: [
          { attributes: { title: 'Plan' }, relationships: { field_kb_attachments: ref('f1') } },
          { attributes: { title: 'Notes' }, relationships: { field_kb_attachments: ref('f1') } },
        ] })
      }
      if (decodeURIComponent(url).includes('[path]=field_kb_images.id')) {
        return json({ data: [{ attributes: { title: 'Notes' }, relationships: { field_kb_images: ref('f2') } }] })
      }
      return json({ data: files })
    })
    vi.stubGlobal('fetch', fetch)

    const { items } = await handler(event)
    expect(items.map(file => [file.id, file.usedOn])).toEqual([['f1', ['Plan', 'Notes']], ['f2', ['Notes']], ['f3', []]])
  })

  it('refuses a caller with no session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ meta: {} })))
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 401 })
  })
})
