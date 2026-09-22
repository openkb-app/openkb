// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref, type Ref } from 'vue'
import * as Y from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import { useEntityFields } from './useEntityFields'

/**
 * Runs a composable inside a real mounted component, so its `onMounted` /
 * `onBeforeUnmount` hooks fire exactly as they do in the app.
 */
function mounted<T>(setup: () => T): { result: T, unmount: () => void } {
  let result!: T
  const app = createApp(defineComponent({
    setup() {
      result = setup()
      return () => h('div')
    },
  }))
  app.mount(document.createElement('div'))
  return { result, unmount: () => app.unmount() }
}

/** Minimal stand-in for the y-protocols awareness the provider exposes. */
function fakeAwareness(clientID: number) {
  const states = new Map<number, Record<string, unknown>>()
  const listeners = new Set<() => void>()
  return {
    clientID,
    getStates: () => states,
    setLocalStateField(key: string, value: unknown) {
      states.set(clientID, { ...(states.get(clientID) ?? {}), [key]: value })
      listeners.forEach(fn => fn())
    },
    /** A remote peer's state arriving over the wire. */
    setPeerState(id: number, state: Record<string, unknown>) {
      states.set(id, state)
      listeners.forEach(fn => fn())
    },
    on: (_event: string, fn: () => void) => { listeners.add(fn) },
    off: (_event: string, fn: () => void) => { listeners.delete(fn) },
  }
}

function providerRef(awareness: ReturnType<typeof fakeAwareness>) {
  return ref({ awareness }) as unknown as Ref<HocuspocusProvider | null>
}

/** Two Y.Docs wired to each other, as two browsers in one session are. */
function connectedDocs(): [Y.Doc, Y.Doc] {
  const a = new Y.Doc()
  const b = new Y.Doc()
  a.on('update', update => Y.applyUpdate(b, update))
  b.on('update', update => Y.applyUpdate(a, update))
  return [a, b]
}

const unmounts: Array<() => void> = []
afterEach(() => {
  unmounts.splice(0).forEach(fn => fn())
})

function fieldsOf(ydoc: Y.Doc, provider?: Ref<HocuspocusProvider | null>) {
  const { result, unmount } = mounted(() => useEntityFields({
    ydoc,
    provider,
    user: { name: 'You', color: '#0ea5e9' },
  }))
  unmounts.push(unmount)
  return result
}

describe('useEntityFields', () => {
  it('exposes the server-seeded map, no field names of its own', () => {
    const ydoc = new Y.Doc()
    ydoc.getMap('fields').set('summary', 'seeded from Drupal')
    ydoc.getMap('fields').set('owner', { id: 'uuid-marta', label: 'Marta Vogel' })

    const { fields, seeded } = fieldsOf(ydoc)

    expect(seeded.value).toBe(true)
    expect(fields.value).toEqual({
      summary: 'seeded from Drupal',
      owner: { id: 'uuid-marta', label: 'Marta Vogel' },
    })
  })

  it('is not seeded before the session syncs', () => {
    expect(fieldsOf(new Y.Doc()).seeded.value).toBe(false)
  })

  it('writes through to the Y.Map and reflects remote writes back', async () => {
    const ydoc = new Y.Doc()
    ydoc.getMap('fields').set('summary', 'first')
    const { fields, field } = fieldsOf(ydoc)

    field('summary').value = 'typed locally'
    expect(ydoc.getMap('fields').get('summary')).toBe('typed locally')

    ydoc.getMap('fields').set('summary', 'from a peer')
    await nextTick()
    expect(fields.value.summary).toBe('from a peer')
    expect(field('summary').value).toBe('from a peer')
  })

  it('does not re-broadcast a value it just received', async () => {
    const ydoc = new Y.Doc()
    ydoc.getMap('fields').set('summary', 'x')
    const { field } = fieldsOf(ydoc)
    let updates = 0
    ydoc.getMap('fields').observe(() => { updates += 1 })

    field('summary').value = 'x'

    expect(updates).toBe(0)
  })

  it('two peers editing different fields both survive', async () => {
    const [docA, docB] = connectedDocs()
    docA.getMap('fields').set('summary', 'seed')
    docA.getMap('fields').set('type', 'article')
    const a = fieldsOf(docA)
    const b = fieldsOf(docB)

    a.field('summary').value = 'written by A'
    b.field('type').value = 'adr'
    await nextTick()

    for (const peer of [a, b]) {
      expect(peer.fields.value.summary).toBe('written by A')
      expect(peer.fields.value.type).toBe('adr')
    }
  })

  it('two peers editing the same field converge last-writer-wins', async () => {
    const [docA, docB] = connectedDocs()
    docA.getMap('fields').set('summary', 'seed')
    const a = fieldsOf(docA)
    const b = fieldsOf(docB)

    a.field('summary').value = 'A wrote first'
    b.field('summary').value = 'B wrote last'
    await nextTick()

    expect(a.fields.value.summary).toBe(b.fields.value.summary)
    expect(b.fields.value.summary).toBe('B wrote last')
  })

  it('a multi-value field merges whole, never item by item', async () => {
    const [docA, docB] = connectedDocs()
    docA.getMap('fields').set('tags', [{ id: 'a', label: 'a' }])
    const a = fieldsOf(docA)
    const b = fieldsOf(docB)

    a.field('tags').value = [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }]
    await nextTick()

    expect(b.fields.value.tags).toEqual([{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }])
    expect(docA.getMap('fields').get('tags')).toEqual(docB.getMap('fields').get('tags'))
  })

  it('publishes which field this client is editing', async () => {
    const awareness = fakeAwareness(1)
    const { focusField } = fieldsOf(new Y.Doc(), providerRef(awareness))
    await nextTick()

    focusField('summary')

    expect(awareness.getStates().get(1)).toEqual({
      user: { name: 'You', color: '#0ea5e9' },
      editingField: 'summary',
    })
  })

  it('groups peers by the field they are editing, excluding this client', async () => {
    const awareness = fakeAwareness(1)
    const { peersByField, focusField } = fieldsOf(new Y.Doc(), providerRef(awareness))
    await nextTick()
    focusField('summary')

    awareness.setPeerState(2, { user: { name: 'Marta', color: '#f00' }, editingField: 'summary' })
    awareness.setPeerState(3, { user: { name: 'Jo', color: '#0f0' }, editingField: 'tags' })
    awareness.setPeerState(4, { user: { name: 'Idle', color: '#00f' } })

    expect(peersByField.value.summary).toEqual([{ clientId: 2, name: 'Marta', color: '#f00' }])
    expect(peersByField.value.tags).toEqual([{ clientId: 3, name: 'Jo', color: '#0f0' }])
    expect(Object.keys(peersByField.value)).toEqual(['summary', 'tags'])
  })

  it('stops announcing the focused field when the editor unmounts', async () => {
    const awareness = fakeAwareness(1)
    const { result, unmount } = mounted(() => useEntityFields({
      ydoc: new Y.Doc(),
      provider: providerRef(awareness),
    }))
    await nextTick()
    result.focusField('summary')

    unmount()

    expect(awareness.getStates().get(1)?.editingField).toBeNull()
  })
})
