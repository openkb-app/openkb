import { vi } from 'vitest'
import type { H3Event } from 'h3'

/** The request parts of a fake event besides its headers. */
export interface EventInit {
  method?: string
  /** The request URL: path plus query. */
  path?: string
  /** Router params, as `getRouterParam()` reads them. */
  params?: Record<string, string>
  context?: Record<string, unknown>
  remoteAddress?: string
}

/** A fake event; `sent` holds the response headers the code set. */
export type FakeEvent = H3Event & { sent: Record<string, string> }

/** An event as h3's request and response helpers read and write one. */
export function makeEvent(
  headers: Record<string, string | undefined> = { Cookie: 'SESS=x' },
  { method = 'GET', path = '/', params = {}, context = {}, remoteAddress }: EventInit = {},
): FakeEvent {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  )
  const sent: Record<string, string> = {}
  const event = {
    method,
    path,
    context: { params, ...context },
    node: {
      req: { url: path, method, headers: lower, socket: { remoteAddress } },
      res: {
        statusCode: 200,
        setHeader: (name: string, value: string) => { sent[name] = value },
      },
    },
    sent,
  }
  return event as unknown as FakeEvent
}

/** One stubbed answer; `offline` makes the call throw as an unreachable host does. */
export interface Reply { status?: number, body?: unknown, text?: string, offline?: boolean }

/**
 * Stubs the global `fetch` and records every call. A URL containing one of
 * `responses`' paths gets that reply (`''` matches every URL); a list of
 * replies is consumed in order and its last one answers every later call.
 * Anything else answers 200 `{}`.
 */
export function stubFetch(responses: Record<string, Reply | Reply[]> = {}) {
  const calls: Array<{ url: string, init: RequestInit }> = []
  const seen = new Map<string, number>()
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, init })
    const [path, reply] = Object.entries(responses).find(([path]) => url.includes(path)) ?? ['', {}]
    const replies = Array.isArray(reply) ? reply : [reply]
    const attempt = seen.get(path) ?? 0
    seen.set(path, attempt + 1)
    const { status = 200, body = {}, text, offline = false } = replies[Math.min(attempt, replies.length - 1)]!
    if (offline) throw new TypeError('fetch failed')
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => text ?? JSON.stringify(body),
    } as unknown as Response
  }))
  return calls
}
