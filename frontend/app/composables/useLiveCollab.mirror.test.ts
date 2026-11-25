// @vitest-environment happy-dom
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref, toValue } from 'vue'
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { useBeforeUnloadGuard } from './useBeforeUnloadGuard'
import { MIRROR_OPEN_TIMEOUT_MS, mirrorKey, useLiveCollab } from './useLiveCollab'

interface ProviderOptions {
  onSynced: () => void
  onAuthenticated: () => void
  onUnsyncedChanges: (event: { number: number }) => void
}

const providers: Array<{ options: ProviderOptions, hasUnsyncedChanges: boolean }> = []

vi.mock('@hocuspocus/provider', () => ({
  HocuspocusProvider: class {
    destroy = vi.fn()
    onMessage = vi.fn()
    on = vi.fn()
    hasUnsyncedChanges = false
    constructor(public options: ProviderOptions) { providers.push(this) }
  },
}))

/** The server confirms a checkpoint: `_meta.last_commit` advances. */
function checkpoint(server: Y.Doc, doc: Y.Doc, at: number) {
  const known = Y.encodeStateVector(doc)
  server.getMap('_meta').set('last_commit', { at })
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(server, known), 'server')
}

/** A local keystroke: inserts one letter into the body. */
const typeLetter = (doc: Y.Doc) => doc.getText('body').insert(0, 'x')

/** A local edit: appends a paragraph to the editor's fragment. */
function typeParagraph(doc: Y.Doc, text: string) {
  const paragraph = new Y.XmlElement('paragraph')
  paragraph.insert(0, [new Y.XmlText(text)])
  doc.getXmlFragment('default').push([paragraph])
}

/** The editor's fragment as plain text. */
const fragmentText = (doc: Y.Doc) => doc.getXmlFragment('default').toDOM().textContent

/** A browser's copy of the server's document, as the first sync leaves it. */
function syncedCopy(server: Y.Doc): Y.Doc {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(server), 'server')
  return doc
}

/** A server document rebuilt from Drupal: same text, no writer in common. */
function rebuiltDocument(text: string): Y.Doc {
  const doc = new Y.Doc()
  typeParagraph(doc, text)
  return doc
}

/** Waits for fake-indexeddb to run the queued requests. */
const waitForIndexedDb = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))

/** Lets pending promise callbacks run, but no IndexedDB request. */
const flushMicrotasks = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

/**
 * Mounts a page editor on `doc`; `sync` answers its first sync and waits for
 * the mirror. The session acts as the mounted account unless `currentLocalKey`
 * says otherwise.
 */
function mountEditor(doc: Y.Doc, localKey: string | null, currentLocalKey = async () => localKey) {
  let session!: ReturnType<typeof useLiveCollab>
  const app = createApp(defineComponent({
    setup() {
      session = useLiveCollab({ ydoc: doc, name: 'node:1', localKey, currentLocalKey })
      return () => h('div')
    },
  }))
  app.mount(document.createElement('div'))
  const provider = providers.at(-1)!
  return {
    session,
    provider,
    unmount: () => app.unmount(),
    /** Answers the first sync and waits until the stored mirror is decided. */
    async sync() {
      provider.options.onSynced()
      await vi.waitFor(() => expect(session.synced.value).toBe(true))
    },
  }
}

/** The body as a fresh mirror of `localKey` loads it from IndexedDB. */
async function mirroredBody(localKey: string): Promise<string> {
  const mirror = new IndexeddbPersistence(localKey, new Y.Doc())
  await mirror.whenSynced
  const body = mirror.doc.getText('body').toString()
  await mirror.destroy()
  return body
}

/** Whether leaving the page now would ask the browser to confirm. */
function confirmsUnload(): boolean {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

describe('useLiveCollab offline mirror', () => {
  beforeEach(() => {
    providers.length = 0
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('onMounted', onMounted)
    vi.stubGlobal('onBeforeUnmount', onBeforeUnmount)
    vi.stubGlobal('toValue', toValue)
    vi.stubGlobal('useBeforeUnloadGuard', useBeforeUnloadGuard)
    vi.stubGlobal('onBeforeRouteLeave', () => {})
    vi.stubGlobal('onBeforeRouteUpdate', () => {})
    vi.stubGlobal('csrfToken', async () => 'browser-token')
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps mirroring edits when a checkpoint arrives while the last clear still waits on IndexedDB', async () => {
    const server = new Y.Doc()
    const doc = new Y.Doc()
    const editor = mountEditor(doc, 'openkb-node-1')
    await editor.sync()
    await waitForIndexedDb()
    checkpoint(server, doc, 1)
    await waitForIndexedDb()

    // Re-creates the mirror; its open is still pending when the next
    // checkpoint clears it, then one more checkpoint follows.
    typeLetter(doc)
    checkpoint(server, doc, 2)
    checkpoint(server, doc, 3)
    await flushMicrotasks()
    typeLetter(doc)
    await waitForIndexedDb()
    typeLetter(doc)
    await waitForIndexedDb()

    expect(await mirroredBody('openkb-node-1')).toBe('xxx')
    editor.unmount()
  })

  it('keeps mirroring edits of a page remounted right after a checkpoint', async () => {
    const server = new Y.Doc()
    const before = new Y.Doc()
    const first = mountEditor(before, 'openkb-node-2')
    await first.sync()
    await waitForIndexedDb()
    typeLetter(before)
    await waitForIndexedDb()
    checkpoint(server, before, 10)
    first.unmount()

    const after = new Y.Doc()
    const second = mountEditor(after, 'openkb-node-2')
    await second.sync()
    await waitForIndexedDb()
    typeLetter(after)
    await waitForIndexedDb()

    expect(await mirroredBody('openkb-node-2')).toBe('x')
    second.unmount()
  })

  it('merges a mirror of the same document, edits made offline included', async () => {
    const server = rebuiltDocument('Held by the server.')
    const tab = syncedCopy(server)
    const first = mountEditor(tab, 'openkb-node-3')
    await first.sync()
    // Offline: the server never acknowledges this edit.
    typeParagraph(tab, 'Typed offline.')
    await waitForIndexedDb()
    first.unmount()

    const reopened = syncedCopy(server)
    const second = mountEditor(reopened, 'openkb-node-3')
    await second.sync()

    expect(fragmentText(reopened)).toBe('Held by the server.Typed offline.')
    expect(second.session.keptCopy.value).toBeNull()
    second.unmount()
  })

  it('clears a mirror of a rebuilt document once the server held all its edits', async () => {
    const tab = syncedCopy(rebuiltDocument('Old text.'))
    const first = mountEditor(tab, 'openkb-node-4')
    await first.sync()
    typeParagraph(tab, 'Acknowledged.')
    await waitForIndexedDb()
    first.provider.options.onUnsyncedChanges({ number: 0 })
    await waitForIndexedDb()
    first.unmount()

    const fresh = syncedCopy(rebuiltDocument('Text Drupal holds.'))
    const second = mountEditor(fresh, 'openkb-node-4')
    await second.sync()

    expect(fragmentText(fresh)).toBe('Text Drupal holds.')
    expect(second.session.keptCopy.value).toBeNull()
    expect(second.session.mirrorEnabled.value).toBe(true)
    second.unmount()
  })

  it('keeps unacknowledged edits of a rebuilt document apart until discarded', async () => {
    const tab = syncedCopy(rebuiltDocument('Old text.'))
    const first = mountEditor(tab, 'openkb-node-5')
    await first.sync()
    const typedAt = Date.now()
    typeParagraph(tab, 'Typed offline.')
    await waitForIndexedDb()
    first.unmount()

    const fresh = syncedCopy(rebuiltDocument('Text Drupal holds.'))
    const second = mountEditor(fresh, 'openkb-node-5')
    await second.sync()
    expect(fragmentText(fresh)).toBe('Text Drupal holds.')
    expect(second.session.keptCopy.value!.since).toBeGreaterThanOrEqual(typedAt)
    expect(second.session.mirrorEnabled.value).toBe(false)
    expect(await second.session.keptCopyMarkdown()).toContain('Typed offline.')
    second.unmount()

    // Still kept on the next open.
    const again = syncedCopy(rebuiltDocument('Text Drupal holds.'))
    const third = mountEditor(again, 'openkb-node-5')
    await third.sync()
    expect(third.session.keptCopy.value).not.toBeNull()

    third.session.discardKeptCopy()
    expect(third.session.keptCopy.value).toBeNull()
    expect(third.session.mirrorEnabled.value).toBe(true)
    typeLetter(again)
    await waitForIndexedDb()
    expect(await mirroredBody('openkb-node-5')).toBe('x')
    third.unmount()
  })

  it('opens without a mirror when IndexedDB does not answer, and asks before leaving', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('indexedDB', { open: () => ({}) })
    const editor = mountEditor(new Y.Doc(), 'openkb-node-6')
    editor.provider.options.onSynced()
    await vi.advanceTimersByTimeAsync(MIRROR_OPEN_TIMEOUT_MS - 1)
    expect(editor.session.synced.value).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(editor.session.synced.value).toBe(true)
    expect(editor.session.mirrorEnabled.value).toBe(false)

    editor.provider.hasUnsyncedChanges = true
    expect(confirmsUnload()).toBe(true)
    editor.provider.hasUnsyncedChanges = false
    expect(confirmsUnload()).toBe(false)
    editor.unmount()
  })

  it('asks before leaving while a checkpoint has cleared the mirror, until the next edit reopens it', async () => {
    const server = new Y.Doc()
    const doc = new Y.Doc()
    const editor = mountEditor(doc, 'openkb-node-9')
    await editor.sync()
    typeLetter(doc)
    editor.provider.hasUnsyncedChanges = true
    expect(confirmsUnload()).toBe(false)

    checkpoint(server, doc, 1)
    expect(confirmsUnload()).toBe(true)

    typeLetter(doc)
    expect(confirmsUnload()).toBe(false)
    editor.unmount()
  })

  it('keeps one user\'s offline edits from another user of the same browser', async () => {
    const server = rebuiltDocument('Held by the server.')
    const tab = syncedCopy(server)
    const first = mountEditor(tab, mirrorKey(10, 1))
    await first.sync()
    typeParagraph(tab, 'Typed offline by user 1.')
    await waitForIndexedDb()
    first.unmount()

    const otherUser = syncedCopy(server)
    const second = mountEditor(otherUser, mirrorKey(10, 2))
    await second.sync()
    expect(fragmentText(otherUser)).toBe('Held by the server.')
    expect(second.session.keptCopy.value).toBeNull()
    second.unmount()

    const sameUser = syncedCopy(server)
    const third = mountEditor(sameUser, mirrorKey(10, 1))
    await third.sync()
    expect(fragmentText(sameUser)).toBe('Held by the server.Typed offline by user 1.')
    third.unmount()
  })

  it('runs without a mirror when the user has no uid, and asks before leaving', async () => {
    expect(mirrorKey(11, null)).toBeNull()
    expect(mirrorKey(11, 0)).toBeNull()

    const doc = new Y.Doc()
    const editor = mountEditor(doc, mirrorKey(11, null))
    await editor.sync()
    typeLetter(doc)
    await waitForIndexedDb()
    expect(editor.session.mirrorEnabled.value).toBe(false)
    expect((await indexedDB.databases()).map(db => db.name)).not.toContain('openkb-node-11-0')

    editor.provider.hasUnsyncedChanges = true
    expect(confirmsUnload()).toBe(true)
    editor.unmount()
  })

  it('stops mirroring once the session re-authenticates as another account', async () => {
    const server = rebuiltDocument('Held by the server.')
    const tab = syncedCopy(server)
    let current: string | null = mirrorKey(12, 1)
    const editor = mountEditor(tab, mirrorKey(12, 1), async () => current)
    await editor.sync()
    typeParagraph(tab, 'Typed by user 1.')
    await waitForIndexedDb()

    // Same account: the mirror stays.
    editor.provider.options.onAuthenticated()
    await waitForIndexedDb()
    expect(editor.session.mirrorEnabled.value).toBe(true)

    // A login as user 2 in another tab.
    current = mirrorKey(12, 2)
    editor.provider.options.onAuthenticated()
    await waitForIndexedDb()
    expect(editor.session.mirrorEnabled.value).toBe(false)
    typeParagraph(tab, 'Typed by user 2.')
    await waitForIndexedDb()
    editor.provider.hasUnsyncedChanges = true
    expect(confirmsUnload()).toBe(true)
    editor.unmount()

    // User 1's mirror holds user 1's edits only.
    const reopened = syncedCopy(server)
    const again = mountEditor(reopened, mirrorKey(12, 1))
    await again.sync()
    expect(fragmentText(reopened)).toBe('Held by the server.Typed by user 1.')
    again.unmount()
  })

  it('merges no mirror before the authentication\'s account check answered', async () => {
    const server = rebuiltDocument('Held by the server.')
    const tab = syncedCopy(server)
    const first = mountEditor(tab, mirrorKey(14, 1))
    await first.sync()
    typeParagraph(tab, 'Typed offline by user 1.')
    await waitForIndexedDb()
    first.unmount()

    // The cookie changed to user 2 between page load and the first authentication.
    let answer!: (key: string | null) => void
    const actor = new Promise<string | null>((resolve) => { answer = resolve })
    const reopened = syncedCopy(server)
    const second = mountEditor(reopened, mirrorKey(14, 1), () => actor)
    second.provider.options.onAuthenticated()
    second.provider.options.onSynced()
    await waitForIndexedDb()
    expect(fragmentText(reopened)).toBe('Held by the server.')

    answer(mirrorKey(14, 2))
    await vi.waitFor(() => expect(second.session.synced.value).toBe(true))
    expect(fragmentText(reopened)).toBe('Held by the server.')
    expect(second.session.mirrorEnabled.value).toBe(false)
    second.unmount()
  })

  it('discards the loaded mirror when the session re-authenticates as another account mid-load', async () => {
    const server = rebuiltDocument('Held by the server.')
    const tab = syncedCopy(server)
    const first = mountEditor(tab, mirrorKey(15, 1))
    await first.sync()
    typeParagraph(tab, 'Typed offline by user 1.')
    await waitForIndexedDb()
    first.unmount()

    let current: string | null = mirrorKey(15, 1)
    const reopened = syncedCopy(server)
    const second = mountEditor(reopened, mirrorKey(15, 1), async () => current)
    second.provider.options.onAuthenticated()
    second.provider.options.onSynced()
    // The account check answered and the mirror loads; IndexedDB has not answered yet.
    await flushMicrotasks()
    current = mirrorKey(15, 2)
    second.provider.options.onAuthenticated()
    await vi.waitFor(() => expect(second.session.synced.value).toBe(true))

    expect(fragmentText(reopened)).toBe('Held by the server.')
    expect(second.session.keptCopy.value).toBeNull()
    expect(second.session.mirrorEnabled.value).toBe(false)
    second.unmount()

    // It stays stored for user 1.
    const owner = syncedCopy(server)
    const third = mountEditor(owner, mirrorKey(15, 1))
    await third.sync()
    expect(fragmentText(owner)).toBe('Held by the server.Typed offline by user 1.')
    third.unmount()
  })

  it('stops mirroring when the account check fails', async () => {
    const doc = new Y.Doc()
    const editor = mountEditor(doc, mirrorKey(16, 1), async () => { throw new Error('actor unavailable') })
    await editor.sync()
    expect(editor.session.mirrorEnabled.value).toBe(true)

    editor.provider.options.onAuthenticated()
    await vi.waitFor(() => expect(editor.session.mirrorEnabled.value).toBe(false))
    typeLetter(doc)
    editor.provider.hasUnsyncedChanges = true
    expect(confirmsUnload()).toBe(true)
    editor.unmount()
  })

  it('does not ask before leaving while the mirror holds the edits', async () => {
    const editor = mountEditor(new Y.Doc(), 'openkb-node-8')
    await editor.sync()

    editor.provider.hasUnsyncedChanges = true
    expect(confirmsUnload()).toBe(false)
    editor.unmount()
  })
})
