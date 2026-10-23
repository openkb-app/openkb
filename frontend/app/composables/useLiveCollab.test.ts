// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'
import * as Y from 'yjs'
import { useLiveCollab } from './useLiveCollab'

interface ProviderOptions {
  onSynced: () => void
  onStatus: (event: { status: 'connecting' | 'connected' | 'disconnected' }) => void
  onAuthenticationFailed: (event: { reason: string }) => void
  onAuthenticated: () => void
}

const providers: Array<{ options: ProviderOptions, destroy: ReturnType<typeof vi.fn> }> = []

vi.mock('@hocuspocus/provider', () => ({
  HocuspocusProvider: class {
    destroy = vi.fn()
    constructor(public options: ProviderOptions) { providers.push(this) }
  },
}))
vi.mock('y-indexeddb', () => ({
  IndexeddbPersistence: class {
    destroy = vi.fn()
    clearData = vi.fn(async () => {})
  },
}))

/** Runs the composable inside a mounted component, as the editor does. */
function mounted(ydoc: Y.Doc) {
  let session!: ReturnType<typeof useLiveCollab>
  const app = createApp(defineComponent({
    setup() {
      session = useLiveCollab({ ydoc, name: 'node:1', localKey: 'openkb-node-1' })
      return () => h('div')
    },
  }))
  app.mount(document.createElement('div'))
  return Object.assign(() => app.unmount(), { session })
}

/** The doc's 'update' listeners — lib0's observable keeps them in a map. */
function updateListeners(ydoc: Y.Doc): number {
  return (ydoc as unknown as { _observers: Map<string, Set<unknown>> })._observers.get('update')?.size ?? 0
}

describe('useLiveCollab disposal', () => {
  beforeEach(() => {
    providers.length = 0
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('onMounted', onMounted)
    vi.stubGlobal('onBeforeUnmount', onBeforeUnmount)
    vi.stubGlobal('csrfToken', async () => 'browser-token')
  })
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

  it('drops the mirror re-creation listener a checkpoint left on the doc', async () => {
    const ydoc = new Y.Doc()
    const unmount = mounted(ydoc)
    const before = updateListeners(ydoc)
    providers[0]!.options.onSynced()

    // A confirmed checkpoint clears the mirror and arms the re-creation.
    ydoc.getMap('_meta').set('last_commit', { at: 1 })
    await vi.waitFor(() => expect(updateListeners(ydoc)).toBe(before + 1))

    unmount()

    expect(updateListeners(ydoc)).toBe(0)
  })
})

describe('useLiveCollab live status', () => {
  beforeEach(() => {
    providers.length = 0
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('onMounted', onMounted)
    vi.stubGlobal('onBeforeUnmount', onBeforeUnmount)
    vi.stubGlobal('csrfToken', async () => 'browser-token')
  })
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
