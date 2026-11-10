// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { useLiveCollab } from './useLiveCollab'

const providers: Array<{ options: { onSynced: () => void } }> = []

vi.mock('@hocuspocus/provider', () => ({
  HocuspocusProvider: class {
    destroy = vi.fn()
    onMessage = vi.fn()
    on = vi.fn()
    constructor(public options: { onSynced: () => void }) { providers.push(this) }
  },
}))

const server = new Y.Doc()

/** The server confirms a checkpoint: `_meta.last_commit` advances. */
function checkpoint(doc: Y.Doc, at: number) {
  const known = Y.encodeStateVector(doc)
  server.getMap('_meta').set('last_commit', { at })
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(server, known), 'server')
}

/** A local keystroke: inserts one letter into the body. */
const typeLetter = (doc: Y.Doc) => doc.getText('body').insert(0, 'x')

/** Waits for fake-indexeddb to run the queued requests. */
const waitForIndexedDb = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))

/** Lets pending promise callbacks run, but no IndexedDB request. */
const flushMicrotasks = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

/** Mounts a page editor on `doc` and lets its collab connection sync. */
function mountEditor(doc: Y.Doc, localKey: string) {
  const app = createApp(defineComponent({
    setup() {
      useLiveCollab({ ydoc: doc, name: 'node:1', localKey })
      return () => h('div')
    },
  }))
  app.mount(document.createElement('div'))
  providers.at(-1)!.options.onSynced()
  return app
}

/** The body as a fresh mirror of `localKey` loads it from IndexedDB. */
async function mirroredBody(localKey: string): Promise<string> {
  const mirror = new IndexeddbPersistence(localKey, new Y.Doc())
  await mirror.whenSynced
  const body = mirror.doc.getText('body').toString()
  await mirror.destroy()
  return body
}

describe('useLiveCollab offline mirror', () => {
  beforeEach(() => {
    providers.length = 0
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('onMounted', onMounted)
    vi.stubGlobal('onBeforeUnmount', onBeforeUnmount)
    vi.stubGlobal('csrfToken', async () => 'browser-token')
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('keeps mirroring edits when a checkpoint arrives while the last clear still waits on IndexedDB', async () => {
    const doc = new Y.Doc()
    const app = mountEditor(doc, 'openkb-node-1')
    await waitForIndexedDb()
    checkpoint(doc, 1)
    await waitForIndexedDb()

    // Re-creates the mirror; its open is still pending when the next
    // checkpoint clears it, then one more checkpoint follows.
    typeLetter(doc)
    checkpoint(doc, 2)
    checkpoint(doc, 3)
    await flushMicrotasks()
    typeLetter(doc)
    await waitForIndexedDb()
    typeLetter(doc)
    await waitForIndexedDb()

    expect(await mirroredBody('openkb-node-1')).toBe('xxx')
    app.unmount()
  })

  it('keeps mirroring edits of a page remounted right after a checkpoint', async () => {
    const before = new Y.Doc()
    const first = mountEditor(before, 'openkb-node-2')
    await waitForIndexedDb()
    typeLetter(before)
    await waitForIndexedDb()
    checkpoint(before, 10)
    first.unmount()

    const after = new Y.Doc()
    const second = mountEditor(after, 'openkb-node-2')
    await waitForIndexedDb()
    typeLetter(after)
    await waitForIndexedDb()

    expect(await mirroredBody('openkb-node-2')).toBe('x')
    second.unmount()
  })
})
