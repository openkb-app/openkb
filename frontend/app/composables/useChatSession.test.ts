// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useChatSession, useChatPanelSession, TRANSPORT_ERROR, AUTH_ERROR } from './useChatSession'
import { SCOPE_ALL } from '#shared/utils/chat-scope'

/**
 * A `/api/chat` that answers with one status and body, so the suite exercises
 * the real `Chat` from `@ai-sdk/vue` rather than a stand-in for it.
 */
function serve(status: number, body: string) {
  const fetch = vi.fn(async () => new Response(body, {
    status,
    headers: { 'content-type': status === 200 ? 'text/event-stream' : 'text/html' },
  }))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

/** A `/api/chat` whose stream stays open until the test pushes into it. */
function serveOpenStream() {
  let push!: (chunk: object) => void
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      push = chunk => controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
    },
  })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })))
  return (chunk: object) => push(chunk)
}

/** One SSE frame per chunk, as the endpoint streams them. */
function sse(...chunks: object[]) {
  return chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
}

afterEach(() => { vi.unstubAllGlobals() })

describe('useChatSession', () => {
  it('answers a question with what the stream carried', async () => {
    serve(200, sse(
      { type: 'start', messageId: 'm1' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Ops owns onboarding.' },
      { type: 'text-end', id: 't1' },
      { type: 'finish' },
    ))
    const session = useChatSession()

    await session.chat.sendMessage({ text: 'Who owns onboarding?' })

    expect(session.error.value).toBeNull()
    expect(session.messages.value).toHaveLength(2)
  })

  it('words a failed request as a sentence, not as the response body', async () => {
    serve(503, '<html><body><h1>503 Service Unavailable</h1></body></html>')
    const session = useChatSession()

    await session.chat.sendMessage({ text: 'Who owns onboarding?' })

    expect(session.error.value).toBe(TRANSPORT_ERROR)
    expect(session.needsAuth.value).toBe(false)
  })

  it('words an unreachable endpoint as a sentence, not as "Failed to fetch"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const session = useChatSession()

    await session.chat.sendMessage({ text: 'Who owns onboarding?' })

    expect(session.error.value).toBe(TRANSPORT_ERROR)
    expect(session.needsAuth.value).toBe(false)
  })

  // Stopping mid-turn must leave no alert behind: it is not an outage.
  it('leaves a stopped turn to the SDK rather than wording it', async () => {
    let seen: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_input: unknown, init?: RequestInit) => {
      seen = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')))
      })
    }))
    const session = useChatSession()

    const turn = session.chat.sendMessage({ text: 'Who owns onboarding?' })
    await vi.waitFor(() => expect(seen).toBeDefined())
    session.chat.stop()
    await turn

    expect(session.error.value).toBeNull()
    expect(session.status.value).toBe('ready')
  })

  it('reads a refused log-in off the status, not out of the body', async () => {
    serve(401, '{"message":"Unauthorized"}')
    const session = useChatSession()

    await session.chat.sendMessage({ text: 'Who owns onboarding?' })

    expect(session.needsAuth.value).toBe(true)
    expect(session.error.value).toBe(AUTH_ERROR)
  })

  it('keeps the assistant\'s own wording for a turn that failed in-band', async () => {
    serve(200, sse(
      { type: 'start', messageId: 'm1' },
      { type: 'error', errorText: 'The AI backend is unavailable right now.' },
    ))
    const session = useChatSession()

    await session.chat.sendMessage({ text: 'Who owns onboarding?' })

    expect(session.error.value).toBe('The AI backend is unavailable right now.')
    expect(session.needsAuth.value).toBe(false)
  })

  it('stops asking for a log-in once a turn is answered again', async () => {
    serve(401, '{"message":"Unauthorized"}')
    const session = useChatSession()
    await session.chat.sendMessage({ text: 'Who owns onboarding?' })
    expect(session.needsAuth.value).toBe(true)

    serve(200, sse(
      { type: 'start', messageId: 'm1' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Ops owns onboarding.' },
      { type: 'text-end', id: 't1' },
      { type: 'finish' },
    ))
    await session.chat.sendMessage({ text: 'Who owns onboarding?' })

    expect(session.needsAuth.value).toBe(false)
    expect(session.error.value).toBeNull()
  })

  // `error` is a get-only accessor on the SDK's chat; assigning to it throws,
  // and the thread would then keep the alert of the turn that failed.
  it('clears the thread and the failed turn with it', async () => {
    serve(401, '{"message":"Unauthorized"}')
    const session = useChatSession()
    await session.chat.sendMessage({ text: 'Who owns onboarding?' })

    session.clear()

    expect(session.messages.value).toEqual([])
    expect(session.error.value).toBeNull()
    expect(session.needsAuth.value).toBe(false)
    expect(session.status.value).toBe('ready')
  })

  it('drops the turn in flight, so its stream cannot refill the thread', async () => {
    const push = serveOpenStream()
    const session = useChatSession()
    void session.chat.sendMessage({ text: 'Who owns onboarding?' }).catch(() => {})
    push({ type: 'start', messageId: 'm1' })
    push({ type: 'text-start', id: 't1' })
    push({ type: 'text-delta', id: 't1', delta: 'Ops owns' })
    await vi.waitUntil(() => session.messages.value.length === 2)

    session.clear()
    push({ type: 'text-delta', id: 't1', delta: ' onboarding.' })
    push({ type: 'finish' })
    // Either the abort unwinds to `ready`, or the dropped stream refills the
    // thread. Whichever lands, the assertion below is the verdict.
    await vi.waitUntil(() =>
      session.status.value === 'ready' || session.messages.value.length > 0)

    expect(session.messages.value).toEqual([])
  })

  /**
   * The panel is remounted by every frame it moves through, so its thread
   * belongs to the app rather than to the component. A caller that asks for a
   * conversation of its own still gets one.
   */
  it('hands every chat panel one thread, and the search summary its own', () => {
    expect(useChatPanelSession()).toBe(useChatPanelSession())
    expect(useChatSession()).not.toBe(useChatPanelSession())
  })

  /** Nothing picked yet is the whole knowledge base. */
  it('scopes the panel to every space until one is picked', () => {
    const session = useChatPanelSession()
    expect(session.scope.value).toBe(SCOPE_ALL)

    // The pick holds for every surface reading the panel's session.
    session.scope.value = 'handbook'
    expect(useChatPanelSession().scope.value).toBe('handbook')

    // The panel session is one object for the whole file.
    session.scope.value = SCOPE_ALL
  })

  /** The pick belongs to the conversation, which a reload ends with it. */
  it('opens a fresh panel on every space again', async () => {
    useChatPanelSession().scope.value = 'ops'
    vi.resetModules()
    const { useChatPanelSession: fresh } = await import('./useChatSession')

    expect(fresh().scope.value).toBe(SCOPE_ALL)
  })
})
