import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, toNodeListener, type H3Event } from 'h3'
import handler from './upload.post'

const headers: Record<string, string | undefined> = {}
let query: Record<string, string> = {}
let bytes = new TextEncoder().encode('a,b\n')
let req: () => Readable = () => Readable.from([bytes])

vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('h3')>()
  return {
    ...actual,
    getQuery: () => query,
    getHeader: (_event: unknown, name: string) => headers[name.toLowerCase()],
  }
})

const IMAGE_LIMIT = 1024 * 1024
let files: Record<string, { extensions: string[], maxBytes: number }> = {}
const fetchFrontmatterSchema = vi.fn(async () => ({ files }))
vi.mock('../../utils/drupal', async importOriginal => ({
  ...await importOriginal<typeof import('../../utils/drupal')>(),
  fetchFrontmatterSchema: () => fetchFrontmatterSchema(),
}))

const event = { get node() { return { req: req(), res: { setHeader: () => {} } } } } as unknown as H3Event

beforeEach(() => {
  vi.stubGlobal('useRuntimeConfig', () => ({ drupalBaseUrl: 'http://drupal.test' }))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  query = { field: 'attachments' }
  files = { field_kb_images: { extensions: ['png'], maxBytes: IMAGE_LIMIT } }
  bytes = new TextEncoder().encode('a,b\n')
  req = () => Readable.from([bytes])
  for (const key of Object.keys(headers)) delete headers[key]
  headers.authorization = 'Bearer agent-token'
  headers['content-disposition'] = 'file; filename="Q3%20report.csv"'
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('POST /api/files/upload', () => {
  it('streams the body to the field\'s JSON:API upload under the caller\'s carrier', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { id: 'f-uuid' } }), { status: 201 }))
    vi.stubGlobal('fetch', fetch)

    await expect(handler(event)).resolves.toEqual({ id: 'f-uuid' })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('http://drupal.test/jsonapi/node/kb_page/field_kb_attachments')
    expect(init.method).toBe('POST')
    expect(await new Response(init.body).text()).toBe('a,b\n')
    expect(init.headers).toMatchObject({
      'Authorization': 'Bearer agent-token',
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'file; filename="Q3 report.csv"',
    })
  })

  it('refuses an unknown field and a missing name before reaching Drupal', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    query = { field: 'body' }
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 400 })
    query = { field: 'images' }
    delete headers['content-disposition']
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 400 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses an anonymous upload', async () => {
    delete headers.authorization
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 401 })
  })

  it('refuses a body over the limit Drupal publishes for the field, by header and by count', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    query = { field: 'images' }
    headers['content-length'] = String(IMAGE_LIMIT + 1)
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 413 })
    expect(fetch).not.toHaveBeenCalled()

    delete headers['content-length']
    bytes = new Uint8Array(IMAGE_LIMIT + 1)
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      await new Response(init.body).arrayBuffer()
      return new Response(JSON.stringify({ data: { id: 'f-uuid' } }), { status: 201 })
    }))
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 413 })
  })

  it('leaves the size to Drupal where it publishes no limit', async () => {
    files = {}
    query = { field: 'images' }
    bytes = new Uint8Array(IMAGE_LIMIT + 1)
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      await new Response(init.body).arrayBuffer()
      return new Response(JSON.stringify({ data: { id: 'f-uuid' } }), { status: 201 })
    }))
    await expect(handler(event)).resolves.toEqual({ id: 'f-uuid' })
  })

  it('answers an oversized chunked upload with 413, not a reset', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      await new Response(init.body).arrayBuffer()
      return new Response(JSON.stringify({ data: { id: 'f-uuid' } }), { status: 201 })
    }))
    query = { field: 'images' }
    const server = createServer(toNodeListener(createApp().use(handler)))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const response = await new Promise<{ status: number, connection?: string }>((resolve, reject) => {
        const client = request({ port: (server.address() as AddressInfo).port, method: 'POST' }, (res) => {
          res.resume()
          resolve({ status: res.statusCode!, connection: res.headers.connection })
        })
        client.on('error', reject)
        const chunk = new Uint8Array(1024 * 1024)
        let sent = 0
        const write = () => {
          while (sent < 4 && !client.destroyed) {
            sent++
            if (!client.write(chunk)) return client.once('drain', write)
          }
          client.end()
        }
        write()
      })
      expect(response).toEqual({ status: 413, connection: 'close' })
    }
    finally {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('reads the body only as the upstream takes it', async () => {
    let pulled = 0
    req = () => new Readable({
      read() {
        pulled++
        this.push(new Uint8Array(1024 * 1024))
      },
    })
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      await (init.body as ReadableStream<Uint8Array>).getReader().read()
      await new Promise(resolve => setTimeout(resolve, 20))
      return new Response(JSON.stringify({ data: { id: 'f-uuid' } }), { status: 201 })
    }))
    await expect(handler(event)).resolves.toEqual({ id: 'f-uuid' })
    expect(pulled).toBeLessThanOrEqual(2)
  })

  it('passes Drupal\'s size and extension refusals through', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 413 })))
    await expect(handler(event)).rejects.toMatchObject({ statusCode: 413 })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      errors: [{ detail: 'Only files with the following extensions are allowed: pdf.' }],
    }), { status: 422 })))
    await expect(handler(event)).rejects.toMatchObject({
      statusCode: 422,
      data: { violations: [{ detail: 'Only files with the following extensions are allowed: pdf.' }] },
    })
  })
})
