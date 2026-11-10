import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HocuspocusProvider, MessageType, type HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { messageYjsSyncStep1, messageYjsUpdate } from 'y-protocols/sync'
import * as Y from 'yjs'
import { batchRemoteUpdates, REMOTE_BATCH_MS } from './collab-batching'

/** A server message as the socket hands it over. */
function message(type: number, sub?: number, payload = new Uint8Array()): MessageEvent {
  const encoder = encoding.createEncoder()
  encoding.writeVarString(encoder, 'node:1')
  encoding.writeVarUint(encoder, type)
  if (sub !== undefined) encoding.writeVarUint(encoder, sub)
  encoding.writeVarUint8Array(encoder, payload)
  return { data: encoding.toUint8Array(encoder).buffer } as MessageEvent
}

/** A peer typing one letter, as the update it sends. */
function keystroke(peer: Y.Doc, letter: string): MessageEvent {
  let update = new Uint8Array()
  peer.once('update', (u: Uint8Array) => { update = u })
  peer.getText('t').insert(peer.getText('t').length, letter)
  return message(MessageType.Sync, messageYjsUpdate, update)
}

/** A peer moving its caret, as the awareness update it sends. */
function caretMove(peer: Y.Doc): MessageEvent {
  const awareness = new Awareness(peer)
  awareness.setLocalStateField('cursor', { at: peer.getText('t').length })
  return message(MessageType.Awareness, undefined, encodeAwarenessUpdate(awareness, [peer.clientID]))
}

/** Stands in for the provider: applies a document update, and lists what it was handed. */
function fakeProvider(document: Y.Doc) {
  const listeners: Record<string, Array<() => void>> = {}
  const provider = {
    document,
    handled: [] as Array<{ type: number, text: string }>,
    on(event: string, fn: () => void) { (listeners[event] ??= []).push(fn) },
    emit(event: string) { listeners[event]?.forEach(fn => fn()) },
    destroy() { provider.emit('destroy') },
    onMessage(event: MessageEvent) {
      const decoder = decoding.createDecoder(new Uint8Array(event.data))
      decoding.readVarString(decoder)
      const type = decoding.readVarUint(decoder)
      provider.handled.push({ type, text: document.getText('t').toString() })
      if (type !== MessageType.Sync || decoding.readVarUint(decoder) !== messageYjsUpdate) return
      Y.applyUpdate(document, decoding.readVarUint8Array(decoder), provider)
    },
  }
  return provider
}

describe('batchRemoteUpdates', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('applies a window of peer keystrokes as one remote transaction', () => {
    const doc = new Y.Doc()
    const peer = new Y.Doc()
    const provider = fakeProvider(doc)
    batchRemoteUpdates(provider as unknown as HocuspocusProvider)
    const transactions: Y.Transaction[] = []
    doc.on('afterTransaction', (tr: Y.Transaction) => transactions.push(tr))

    for (const letter of 'abc') provider.onMessage(keystroke(peer, letter))
    expect(doc.getText('t').toString()).toBe('')

    vi.advanceTimersByTime(REMOTE_BATCH_MS)
    expect(doc.getText('t').toString()).toBe('abc')
    expect(transactions).toHaveLength(1)
    expect(transactions[0]).toMatchObject({ origin: provider, local: false })
  })

  it('hands every other message on at once', () => {
    const provider = fakeProvider(new Y.Doc())
    batchRemoteUpdates(provider as unknown as HocuspocusProvider)
    provider.onMessage(caretMove(new Y.Doc()))
    provider.onMessage(message(MessageType.Sync, messageYjsSyncStep1))
    expect(provider.handled.map(h => h.type)).toEqual([MessageType.Awareness, MessageType.Sync])
  })

  it('delivers awareness behind a waiting update after it, in arrival order', () => {
    const doc = new Y.Doc()
    const peer = new Y.Doc()
    const provider = fakeProvider(doc)
    batchRemoteUpdates(provider as unknown as HocuspocusProvider)

    provider.onMessage(keystroke(peer, 'a'))
    provider.onMessage(caretMove(peer))
    provider.onMessage(keystroke(peer, 'b'))
    provider.onMessage(caretMove(peer))
    expect(provider.handled).toEqual([])

    vi.advanceTimersByTime(REMOTE_BATCH_MS)
    expect(provider.handled.filter(h => h.type === MessageType.Awareness))
      .toEqual([{ type: MessageType.Awareness, text: 'ab' }, { type: MessageType.Awareness, text: 'ab' }])
  })

  it('keeps the rest of the window when one update throws', () => {
    const doc = new Y.Doc()
    const peer = new Y.Doc()
    const provider = fakeProvider(doc)
    const apply = provider.onMessage
    let failed = false
    provider.onMessage = (event: MessageEvent) => {
      if (!failed) {
        failed = true
        throw new Error('bad update')
      }
      apply(event)
    }
    batchRemoteUpdates(provider as unknown as HocuspocusProvider)

    provider.onMessage(keystroke(peer, 'a'))
    provider.onMessage(keystroke(new Y.Doc(), 'b'))
    expect(() => vi.advanceTimersByTime(REMOTE_BATCH_MS)).toThrow('bad update')
    vi.advanceTimersByTime(REMOTE_BATCH_MS)
    expect(doc.getText('t').toString()).toBe('b')
  })

  it('applies what is waiting on destroy, and batches no more', () => {
    const doc = new Y.Doc()
    const peer = new Y.Doc()
    const provider = fakeProvider(doc)
    batchRemoteUpdates(provider as unknown as HocuspocusProvider)
    provider.onMessage(keystroke(peer, 'a'))
    provider.destroy()
    expect(doc.getText('t').toString()).toBe('a')
    provider.onMessage(keystroke(peer, 'b'))
    expect(doc.getText('t').toString()).toBe('ab')
  })

  it('restores the provider on destroy, even when an update throws', () => {
    const doc = new Y.Doc()
    const provider = fakeProvider(doc)
    const apply = provider.onMessage
    let failed = false
    provider.onMessage = (event: MessageEvent) => {
      if (!failed) {
        failed = true
        throw new Error('bad update')
      }
      apply(event)
    }
    batchRemoteUpdates(provider as unknown as HocuspocusProvider)

    provider.onMessage(keystroke(new Y.Doc(), 'a'))
    provider.onMessage(keystroke(new Y.Doc(), 'b'))
    expect(() => provider.destroy()).toThrow('bad update')
    expect(vi.getTimerCount()).toBe(0)
    provider.onMessage(keystroke(new Y.Doc(), 'c'))
    expect(doc.getText('t').toString()).toBe('c')
  })

  it('drops waiting awareness when the socket closes', () => {
    const doc = new Y.Doc()
    const peer = new Y.Doc()
    const provider = fakeProvider(doc)
    batchRemoteUpdates(provider as unknown as HocuspocusProvider)

    provider.onMessage(keystroke(peer, 'a'))
    provider.onMessage(caretMove(peer))
    provider.emit('close')
    vi.advanceTimersByTime(REMOTE_BATCH_MS)
    expect(doc.getText('t').toString()).toBe('a')
    expect(provider.handled.map(h => h.type)).toEqual([MessageType.Sync])
  })

  it('batches what the socket hands a real provider, and sends nothing back', () => {
    const doc = new Y.Doc()
    const peer = new Y.Doc()
    const socket = {
      attached: null as HocuspocusProvider | null,
      send: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      attach(provider: HocuspocusProvider) { socket.attached = provider },
      detach: vi.fn(),
    }
    const provider = new HocuspocusProvider({
      name: 'node:1',
      document: doc,
      websocketProvider: socket as unknown as HocuspocusProviderWebsocket,
    })
    provider.attach()
    batchRemoteUpdates(provider)
    const transactions: Y.Transaction[] = []
    doc.on('afterTransaction', (tr: Y.Transaction) => transactions.push(tr))

    for (const letter of 'abc') socket.attached!.onMessage(keystroke(peer, letter))
    expect(doc.getText('t').toString()).toBe('')

    vi.advanceTimersByTime(REMOTE_BATCH_MS)
    expect(doc.getText('t').toString()).toBe('abc')
    expect(transactions).toHaveLength(1)
    expect(socket.send).not.toHaveBeenCalled()
    provider.destroy()
  })
})
