import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { createApp, createRouter, toNodeListener, type EventHandler, type H3Event } from 'h3'
import { drupalPassthrough, drupalPath } from './drupal-proxy'
/**
 * A Drupal passthrough: where it forwards, and that a path which would resolve
 * outside its prefix never leaves the app.
 */

const DRUPAL = 'http://drupal.test'
const proxyRequest = vi.fn()

vi.mock('./drupal', () => ({ drupalBaseUrl: () => DRUPAL }))
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('h3')>()
  return { ...actual, proxyRequest: (...a: unknown[]) => proxyRequest(...a) }
})

/** An event as the router hands it over: the raw URL plus the `[...path]` param. */
function event(url: string, param?: string): H3Event {
  return {
    path: url,
    method: 'GET',
    context: { params: param === undefined ? {} : { path: param } },
    node: { req: { url, method: 'GET', headers: { host: 'app.test' } } },
  } as unknown as H3Event
}

/** Runs a handler, a synchronous throw included, as a promise. */
async function run(handler: EventHandler, e: H3Event): Promise<unknown> {
  return handler(e)
}

const CATCH_ALL: [string, EventHandler, string, string][] = [
  ['/prefix', (e: H3Event) => drupalPassthrough(e, 'prefix'), 'a/b.css', 'prefix/a/b.css'],
]

beforeEach(() => {
  proxyRequest.mockReset().mockImplementation((_event, target: string) => target)
})

describe('drupalPath', () => {
  it.each([
    ['', ''], ['a', 'a'], ['a/b.css', 'a/b.css'], ['a/', 'a/'], ['a..b/c', 'a..b/c'],
    ['files/a%20b.png', 'files/a%20b.png'], ['a b.png', 'a%20b.png'], ['café', 'caf%C3%A9'],
    // As the router hands them over: decoded but for `%25` and `%2F`.
    ['.\t./x', '.%09./x'], ['.\n./x', '.%0A./x'], ['.\r./x', '.%0D./x'],
    ['install.php#.js', 'install.php%23.js'], ['a?b', 'a%3Fb'], ['%252e%252e', '%252e%252e'], ['a%25b', 'a%25b'],
  ])('forwards %j as %j', (param, path) => {
    expect(drupalPath(param)).toBe(path)
  })

  it.each([
    '..', 'a/../b', '.', 'a/./b', 'a//b', '/a', '/',
    '%2e%2e/b', 'a/%2E%2e/b', '%2e', 'a%2F..%2Fb', 'a%5c..%5cb', 'a\\..\\b', '%E0%A4%A',
  ])('refuses %j', (param) => {
    expect(drupalPath(param)).toBeUndefined()
  })
})

describe.each(CATCH_ALL)('%s/**', (prefix, handler, param, target) => {
  it('forwards to the prefix plus the router param, query included', async () => {
    await expect(run(handler, event(`${prefix}/${param}?v=1`, param))).resolves.toBe(`${DRUPAL}/${target}?v=1`)
  })

  it('builds the target from the router param, not from the request URL', async () => {
    // A request URL the router matched under the prefix that would resolve elsewhere.
    await run(handler, event(`${prefix}/../../user/1/${param}`, param))
    expect(proxyRequest).toHaveBeenCalledWith(expect.anything(), `${DRUPAL}/${target}`)
  })

  it.each(['../user/1', `x/%2e%2e/../${param}`])('answers 404 for %j', async (bad) => {
    await expect(run(handler, event(`${prefix}/${bad}`, bad))).rejects.toMatchObject({ statusCode: 404 })
    expect(proxyRequest).not.toHaveBeenCalled()
  })
})

/**
 * Through a real h3 router and raw HTTP: the param arrives decoded, so what
 * `fetch` would send must stay under the prefix exactly as built.
 */
describe('through the router', () => {
  let server: Server
  let port: number

  beforeAll(async () => {
    const router = createRouter()
    for (const [prefix, handler] of CATCH_ALL) router.use(`${prefix}/**:path`, handler)
    const app = createApp()
    app.use(router)
    server = createServer(toNodeListener(app))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))

  /** Sends the request line as is; resolves to the status and body. */
  function get(path: string): Promise<{ status: number, body: string }> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => socket.write(`GET ${path} HTTP/1.0\r\nHost: app.test\r\n\r\n`))
      let data = ''
      socket.on('data', (chunk) => { data += chunk })
      socket.on('end', () => {
        const [head = '', body = ''] = data.split('\r\n\r\n')
        resolve({ status: Number(head.split(' ')[1]), body })
      })
      socket.on('error', reject)
    })
  }

  it.each([
    ['/prefix', '.%09./.%09./.%09./user/1/edit'],
    ['/prefix', '.%0a./.%0d./user/1/edit'],
    ['/prefix', 'install.php%23.js'],
    ['/prefix', '%252e%252e/%252e%252e/user/1.png'],
  ])('%s/%s stays under the prefix', async (prefix, attack) => {
    const { status, body } = await get(`${prefix}/${attack}`)
    if (status === 404) return
    expect(status).toBe(200)
    const sent = new URL(body)
    expect(sent.href).toBe(body)
    expect(sent.pathname.startsWith(`${prefix}/`)).toBe(true)
    expect(sent.hash).toBe('')
  })

  it('forwards a plain path', async () => {
    expect(await get('/prefix/a/b.css?v=1')).toEqual({ status: 200, body: `${DRUPAL}/prefix/a/b.css?v=1` })
  })
})
