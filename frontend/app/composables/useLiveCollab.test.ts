// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref, toValue } from 'vue'
import * as Y from 'yjs'
import { useBeforeUnloadGuard } from './useBeforeUnloadGuard'
import { editorAcceptsInput, useLiveCollab } from './useLiveCollab'

interface ProviderOptions {
  onSynced: () => void
  onStatus: (event: { status: 'connecting' | 'connected' | 'disconnected' }) => void
  onAuthenticationFailed: (event: { reason: string }) => void
  onAuthenticated: () => void
}

type Location = { path: string, query: Record<string, string> }

let routeLeaveGuard: () => boolean
let routeUpdateGuard: (to: Location, from: Location) => boolean

const providers: Array<{ options: ProviderOptions, destroy: ReturnType<typeof vi.fn>, hasUnsyncedChanges: boolean }> = []

vi.mock('@hocuspocus/provider', () => ({
  HocuspocusProvider: class {
    destroy = vi.fn()
    onMessage = vi.fn()
    on = vi.fn()
    hasUnsyncedChanges = false
    constructor(public options: ProviderOptions) { providers.push(this) }
  },
}))
// IndexedDB refuses every open: the editor runs without a mirror.
vi.mock('y-indexeddb', () => ({
  IndexeddbPersistence: class {
    constructor() {
      throw new Error('IndexedDB unavailable')
    }
  },
  clearDocument: vi.fn(async () => {}),
}))

/** Runs the composable inside a mounted component, as the editor does. */
function mounted(ydoc: Y.Doc) {
  let session!: ReturnType<typeof useLiveCollab>
  const app = createApp(defineComponent({
    setup() {
      session = useLiveCollab({ ydoc, name: 'node:1', localKey: 'openkb-node-1', currentLocalKey: async () => 'openkb-node-1' })
      return () => h('div')
    },
  }))
  app.mount(document.createElement('div'))
  return Object.assign(() => app.unmount(), { session })
}

/** Answers the first sync and waits until the editor may hydrate. */
async function syncFirst(unmount: ReturnType<typeof mounted>) {
  providers.at(-1)!.options.onSynced()
  await vi.waitFor(() => expect(unmount.session.synced.value).toBe(true))
}

/** The doc's 'update' listeners — lib0's observable keeps them in a map. */
function updateListeners(ydoc: Y.Doc): number {
  return (ydoc as unknown as { _observers: Map<string, Set<unknown>> })._observers.get('update')?.size ?? 0
}

/** Whether leaving the page now would ask the browser to confirm. */
function confirmsUnload(): boolean {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

/** Stubs the auto-imports the composable uses. */
function stubAutoImports() {
  providers.length = 0
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('onMounted', onMounted)
  vi.stubGlobal('onBeforeUnmount', onBeforeUnmount)
  vi.stubGlobal('toValue', toValue)
  vi.stubGlobal('useBeforeUnloadGuard', useBeforeUnloadGuard)
  vi.stubGlobal('onBeforeRouteLeave', (guard: () => boolean) => { routeLeaveGuard = guard })
  vi.stubGlobal('onBeforeRouteUpdate', (guard: typeof routeUpdateGuard) => { routeUpdateGuard = guard })
  vi.stubGlobal('csrfToken', async () => 'browser-token')
}

describe('useLiveCollab disposal', () => {
  beforeEach(stubAutoImports)
  afterEach(() => { vi.unstubAllGlobals() })

  it('destroys the provider on unmount and leaves the doc to its owner', () => {
    const ydoc = new Y.Doc()
    const destroyed = vi.fn()
    ydoc.on('destroy', destroyed)
    const unmount = mounted(ydoc)

    unmount()

    expect(providers[0]!.destroy).toHaveBeenCalled()
    expect(destroyed).not.toHaveBeenCalled()
  })

  it('takes its listeners off the doc on unmount', async () => {
    const ydoc = new Y.Doc()
    const unmount = mounted(ydoc)
    await syncFirst(unmount)
    ydoc.getMap('_meta').set('last_commit', { at: 1 })

    unmount()

    expect(updateListeners(ydoc)).toBe(0)
  })
})

describe('useLiveCollab without a mirror', () => {
  beforeEach(stubAutoImports)
  afterEach(() => { vi.unstubAllGlobals() })

  it('asks to confirm leaving only while edits the server has not acknowledged are pending', async () => {
    const unmount = mounted(new Y.Doc())
    const provider = providers[0]!

    // Before the first sync the editor holds no edits of its own.
    provider.hasUnsyncedChanges = true
    expect(confirmsUnload()).toBe(false)

    await syncFirst(unmount)
    expect(unmount.session.mirrorEnabled.value).toBe(false)
    expect(confirmsUnload()).toBe(true)

    provider.hasUnsyncedChanges = false
    expect(confirmsUnload()).toBe(false)

    provider.hasUnsyncedChanges = true
    unmount()
    expect(confirmsUnload()).toBe(false)
  })

  it('asks to confirm an in-app navigation only while unacknowledged edits are pending', async () => {
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    const unmount = mounted(new Y.Doc())
    const provider = providers[0]!

    provider.hasUnsyncedChanges = true
    expect(routeLeaveGuard()).toBe(true)
    expect(confirm).not.toHaveBeenCalled()

    await syncFirst(unmount)
    expect(routeLeaveGuard()).toBe(false)
    confirm.mockReturnValue(true)
    expect(routeLeaveGuard()).toBe(true)

    provider.hasUnsyncedChanges = false
    confirm.mockClear()
    expect(routeLeaveGuard()).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    unmount()
  })

  it('asks to confirm a route update to another page or out of edit mode', async () => {
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    const unmount = mounted(new Y.Doc())
    await syncFirst(unmount)
    providers[0]!.hasUnsyncedChanges = true
    const editing = { path: '/wiki/a', query: { edit: '' } }

    expect(routeUpdateGuard({ path: '/wiki/a', query: { edit: '', block: 'x' } }, editing)).toBe(true)
    expect(confirm).not.toHaveBeenCalled()

    expect(routeUpdateGuard({ path: '/wiki/b', query: {} }, editing)).toBe(false)
    expect(routeUpdateGuard({ path: '/wiki/a', query: {} }, editing)).toBe(false)
    expect(confirm).toHaveBeenCalledTimes(2)

    providers[0]!.hasUnsyncedChanges = false
    expect(routeUpdateGuard({ path: '/wiki/b', query: {} }, editing)).toBe(true)
    unmount()
  })
})

describe('useLiveCollab live status', () => {
  beforeEach(stubAutoImports)
  afterEach(() => { vi.unstubAllGlobals() })

  it('is live only once the connection has synced, on every reconnect', () => {
    const unmount = mounted(new Y.Doc())
    const { liveStatus, synced } = unmount.session
    const provider = providers[0]!.options

    provider.onStatus({ status: 'connected' })
    expect(liveStatus.value).toBe('connecting')
    expect(synced.value).toBe(false)

    provider.onSynced()
    expect(liveStatus.value).toBe('live')

    provider.onStatus({ status: 'disconnected' })
    expect(liveStatus.value).toBe('offline')
    provider.onStatus({ status: 'connecting' })
    provider.onStatus({ status: 'connected' })
    expect(liveStatus.value).toBe('connecting')

    provider.onSynced()
    expect(liveStatus.value).toBe('live')
    unmount()
  })

  it('waits for the sync after a refused session authenticates', () => {
    const unmount = mounted(new Y.Doc())
    const { liveStatus } = unmount.session
    const provider = providers[0]!.options

    provider.onStatus({ status: 'connected' })
    provider.onAuthenticationFailed({ reason: 'permission-denied' })
    expect(liveStatus.value).toBe('auth-error')
    provider.onStatus({ status: 'connected' })
    expect(liveStatus.value).toBe('auth-error')

    provider.onAuthenticated()
    expect(liveStatus.value).toBe('connecting')
    provider.onSynced()
    expect(liveStatus.value).toBe('live')
    unmount()
  })
})

describe('editorAcceptsInput', () => {
  it('keeps the editor read-only until the body is seeded', () => {
    expect(editorAcceptsInput(false, 'live')).toBe(false)
    expect(editorAcceptsInput(true, 'live')).toBe(true)
  })

  it('keeps it read-only while the collab server rejects the session', () => {
    expect(editorAcceptsInput(true, 'auth-error')).toBe(false)
    expect(editorAcceptsInput(true, 'no-access')).toBe(false)
    expect(editorAcceptsInput(true, 'offline')).toBe(true)
  })
})
