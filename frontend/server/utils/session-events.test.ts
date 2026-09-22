import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { absolutePositionToRelativePosition, initProseMirrorDoc, prosemirrorJSONToYDoc } from '@tiptap/y-tiptap'
import { editorSchema } from './editor-schema'
import { presenceCarrier, publishAwareness, type AwareDoc } from './agent-awareness'
import { applyBlockOps, applyComment, type AgentActor } from './agent-peer'
import { recordCommentMessage } from '#shared/block-comments'
import {
  awaitChanges,
  changesSince,
  isAfterCursor,
  isCursorShaped,
  stopAllWatches,
  watchSession,
  type ChangeEvent,
} from './session-events'

/**
 * The event derivation behind `waitForChanges`, against a real document.
 *
 * Everything here is a Y.Doc plus an awareness — the two things a live session
 * is — so what is asserted is the derivation and not a stand-in for it. The
 * settle windows are shortened to milliseconds; their length is the product
 * decision (server/utils/collab-timing.ts), the settling is the behaviour.
 */

const ACTOR: AgentActor = { token: 'tok-1', uid: 7, name: 'fago', via: 'Claude' }
const FAST = { settleMs: 5, presenceMs: 5 }
/** Longer than a settle window, short enough to keep the suite quick. */
const SETTLED_MS = 60

let humans = 0

function documentWith(blocks: Array<[string, string]>): AwareDoc {
  const doc = prosemirrorJSONToYDoc(editorSchema, {
    type: 'doc',
    content: blocks.map(([id, text]) => ({
      type: 'paragraph',
      attrs: { id },
      content: [{ type: 'text', text }],
    })),
  } as never, 'default') as AwareDoc
  doc.awareness = new Awareness(doc)
  doc.awareness.setLocalState(null)
  return doc
}

function watch(doc: AwareDoc, name = 'node:1') {
  return watchSession({ documentName: name, doc, humanPeers: () => humans }, FAST)
}

/** Everything the log holds, for a reader that asked for everything. */
function seen(log: ReturnType<typeof watch>, cursor?: string, kinds = ALL): ChangeEvent[] {
  return changesSince(log, cursor, kinds).events
}

const ALL = ['comments', 'blocks', 'presence'] as const

const settled = (): Promise<void> => new Promise(resolve => setTimeout(resolve, SETTLED_MS))

/** Writes the way an agent session does — one transaction, carrying its seat. */
function asAgent<T>(doc: AwareDoc, write: () => T): T {
  return Y.transact(doc, write, { agent: true, seat: { uid: 7, name: 'fago', via: 'Claude' } })
}

/** Puts a peer in the room, with the block it claims to be working on. */
function joinPeer(doc: AwareDoc, clientId: number, name: string, blockId?: string, via?: string): void {
  publishAwareness(doc, presenceCarrier(clientId), clientId, {
    user: { name, uid: via ? 7 : 3, ...(via ? { via } : {}) },
    ...(blockId ? { claim: { blocks: [blockId] } } : {}),
  }, null)
}

describe('session events', () => {
  beforeEach(() => {
    humans = 1
  })
  afterEach(stopAllWatches)

  it('reports a block once it settles, with what it now holds — not per keystroke', async () => {
    const doc = documentWith([['b-1', 'first'], ['b-2', 'second']])
    const log = watch(doc)
    const cursor = changesSince(log, undefined, ALL).cursor

    // Three writes in a burst, the way typing arrives.
    for (const text of ['fir', 'first draft', 'first draft, done']) {
      applyBlockOps(doc, [{ id: 'b-1', markdown: text }])
    }
    await settled()

    const events = seen(log, cursor)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'blocks',
      blockId: 'b-1',
      markdown: 'first draft, done {#b-1}',
    })
    // The version is the one an updateBlocks `expect` sends back.
    expect((events[0] as { version: string }).version).toMatch(/^[0-9a-f]{12}$/)
  })

  it('names who changed the block, from the transaction that carried it', async () => {
    const doc = documentWith([['b-1', 'first']])
    const log = watch(doc)
    const cursor = changesSince(log, undefined, ALL).cursor

    asAgent(doc, () => applyBlockOps(doc, [{ id: 'b-1', markdown: 'the agent wrote this' }]))
    await settled()

    expect(seen(log, cursor)[0]).toMatchObject({ kind: 'blocks', by: { uid: 7, via: 'Claude' } })
  })

  it('reports a thread when it is opened and again when it is answered', async () => {
    const doc = documentWith([['b-1', 'first']])
    const log = watch(doc)
    const cursor = changesSince(log, undefined, ALL).cursor

    const { threadId } = applyComment(doc, ACTOR, { blockId: 'b-1', text: 'Needs a source.' })
    applyComment(doc, ACTOR, { blockId: 'b-1', threadId, text: 'Added one.' })

    const events = seen(log, cursor).filter(event => event.kind === 'comments')
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ kind: 'comments', thread: { blockId: 'b-1', threadId } })
    // The whole thread every time: a reader acts on the conversation, not on
    // the message that happened to arrive.
    expect((events[1] as { thread: { messages: unknown[] } }).thread.messages).toHaveLength(2)
  })

  it('reports who arrived, where they are, and when they left', async () => {
    const doc = documentWith([['b-1', 'first'], ['b-2', 'second']])
    const log = watch(doc)
    const cursor = changesSince(log, undefined, ALL).cursor

    const carrier = presenceCarrier(101)
    publishAwareness(doc, carrier, 101, { user: { name: 'editor1', uid: 3 }, claim: { blocks: ['b-1'] } }, null)
    await settled()
    publishAwareness(doc, carrier, 101, { user: { name: 'editor1', uid: 3 }, claim: { blocks: ['b-2'] } }, null)
    await settled()

    expect(seen(log, cursor).map(event => [event.kind, (event as { event: string }).event]))
      .toEqual([['presence', 'joined'], ['presence', 'moved']])
    expect(seen(log, cursor)[1]).toMatchObject({ who: { name: 'editor1', uid: 3 }, blockId: 'b-2' })
  })

  it('resolves a browser peer\'s caret to the block it sits in', async () => {
    const doc = documentWith([['b-1', 'first'], ['b-2', 'second']])
    const fragment = doc.getXmlFragment('default')
    const { doc: pm, mapping } = initProseMirrorDoc(fragment, editorSchema)
    // A position inside the second paragraph, as a peer's caret rides
    // awareness: a relative position, not an offset.
    const inside = pm.child(0).nodeSize + 2
    const anchor = absolutePositionToRelativePosition(inside, fragment, mapping)

    const log = watch(doc)
    const cursor = changesSince(log, undefined, ALL).cursor
    publishAwareness(doc, presenceCarrier(102), 102, {
      user: { name: 'editor2', uid: 4 },
      cursor: { anchor, head: anchor },
    } as never, null)
    await settled()

    expect(seen(log, cursor)[0]).toMatchObject({ kind: 'presence', event: 'joined', blockId: 'b-2' })
  })

  it('leaves the watcher\'s own presence out of what it reads', async () => {
    const doc = documentWith([['b-1', 'first']])
    const log = watch(doc)
    const cursor = changesSince(log, undefined, ALL).cursor

    joinPeer(doc, 103, 'the agent itself', 'b-1')
    await settled()

    expect(changesSince(log, cursor, ALL, { clientId: 103 }).events).toEqual([])
    expect(changesSince(log, cursor, ALL).events).toHaveLength(1)
  })

  it('leaves the watcher\'s own presence out under a new client id', async () => {
    const doc = documentWith([['b-1', 'first']])
    const log = watch(doc)
    const cursor = changesSince(log, undefined, ALL).cursor

    // The same agent calling again: a client id of its own, one account and
    // one label.
    joinPeer(doc, 104, 'the agent itself', 'b-1', 'Claude')
    await settled()

    expect(changesSince(log, cursor, ALL, { clientId: 105, uid: 7, via: 'Claude' }).events).toEqual([])
    expect(changesSince(log, cursor, ALL, { clientId: 105, uid: 7, via: null }).events).toHaveLength(1)
  })

  it('serves only the kinds a reader asked for — and every session event', async () => {
    const doc = documentWith([['b-1', 'first']])
    const log = watch(doc)
    const cursor = changesSince(log, undefined, ALL).cursor

    applyComment(doc, ACTOR, { blockId: 'b-1', text: 'Needs a source.' })
    applyBlockOps(doc, [{ id: 'b-1', markdown: 'rewritten' }])
    await settled()

    expect(changesSince(log, cursor, ['comments']).events.map(event => event.kind)).toEqual(['comments'])
    expect(changesSince(log, cursor, ['blocks']).events.map(event => event.kind)).toEqual(['blocks'])
  })

  it('resumes from the cursor: what came before it is not served twice', async () => {
    const doc = documentWith([['b-1', 'first']])
    const log = watch(doc)
    const first = await awaitChanges(log, undefined, ALL, 20)
    applyComment(doc, ACTOR, { blockId: 'b-1', text: 'One.' })

    const answered = changesSince(log, first.cursor, ALL)
    expect(answered.events.map(event => (event as { thread: { messages: Array<{ text: string }> } })
      .thread.messages[0]!.text)).toEqual(['One.'])

    // The cursor that answer carried starts empty, and stays empty until
    // something else happens.
    expect(changesSince(log, answered.cursor, ALL).events).toEqual([])
  })

  it('a cursor from another log starts the reader at the head, and says so at once', async () => {
    const doc = documentWith([['b-1', 'first']])
    const log = watch(doc)
    applyComment(doc, ACTOR, { blockId: 'b-1', text: 'Said before you asked.' })

    expect(changesSince(log, 'deadbeef:0', ALL)).toMatchObject({ events: [], restarted: true })
    // And the wait does not burn its whole timeout on a log that cannot place it.
    const answered = await awaitChanges(log, 'deadbeef:0', ALL, 5_000)
    expect(answered.restarted).toBe(true)
  })

  it('dates a document change against a cursor, leaving the cursor\'s own millisecond to the log', () => {
    const doc = documentWith([['b-1', 'first']])
    const log = watchSession({ documentName: 'node:1', doc, humanPeers: () => humans }, { ...FAST, now: () => 1_000 })
    const { cursor } = changesSince(log, undefined, ALL)

    expect(isAfterCursor(log, undefined, 1)).toBe(true)
    expect(isAfterCursor(log, cursor, 999)).toBe(false)
    expect(isAfterCursor(log, cursor, 1_001)).toBe(true)
    // The log holds everything after the cursor: it reports a change from that
    // millisecond itself, and one before the cursor was answered already.
    expect(isAfterCursor(log, cursor, 1_000)).toBe(false)
    // A log that cannot serve the cursor leaves only the document to ask.
    expect(isAfterCursor(log, 'deadbeef:0:1000', 1_000)).toBe(true)
    applyComment(doc, ACTOR, { blockId: 'b-1', text: 'One.' })
    log.events.splice(0, log.events.length)
    expect(isAfterCursor(log, cursor, 1_000)).toBe(true)
  })

  it('leaves the cursor\'s millisecond to the document once the log stopped', () => {
    const doc = documentWith([['b-1', 'first']])
    const log = watchSession({ documentName: 'node:1', doc, humanPeers: () => humans }, { ...FAST, now: () => 1_000 })
    const { cursor } = changesSince(log, undefined, ALL)

    log.stop()
    expect(isAfterCursor(log, cursor, 1_000)).toBe(true)
  })

  it('a cursor the log has overrun is answered with what is left, flagged', async () => {
    const doc = documentWith([['b-1', 'first']])
    const log = watch(doc)
    const { cursor } = changesSince(log, undefined, ALL)
    applyComment(doc, ACTOR, { blockId: 'b-1', text: 'One.' })
    // The oldest event falls off, so the reader cannot be served from `cursor`.
    log.events.splice(0, log.events.length)

    expect(changesSince(log, cursor, ALL)).toMatchObject({ dropped: true })
  })

  it('reports a block that left the page', async () => {
    const doc = documentWith([['b-1', 'first'], ['b-2', 'second']])
    const log = watch(doc)
    const cursor = changesSince(log, undefined, ALL).cursor

    // What a human deleting the paragraph leaves behind, at the Y level.
    doc.getXmlFragment('default').delete(1, 1)
    await settled()

    expect(seen(log, cursor)).toEqual([
      expect.objectContaining({ kind: 'blocks', event: 'removed', blockId: 'b-2', markdown: null }),
    ])
  })

  it('leaves out what the reader itself wrote and said', async () => {
    const doc = documentWith([['b-1', 'first']])
    const log = watch(doc)
    const cursor = changesSince(log, undefined, ALL).cursor
    const self = { uid: 7, via: 'Claude' }

    asAgent(doc, () => applyComment(doc, ACTOR, { blockId: 'b-1', text: 'Done — have a look.' }))
    asAgent(doc, () => applyBlockOps(doc, [{ id: 'b-1', markdown: 'the agent wrote this' }]))
    await settled()

    expect(changesSince(log, cursor, ALL, self).events).toEqual([])
    // The same account editing in a browser carries no label, and is news.
    expect(changesSince(log, cursor, ALL, { uid: 7, via: null }).events).toHaveLength(2)
  })

  it('tells the agent its thread was resolved — a resolve bears no message', () => {
    const doc = documentWith([['b-1', 'first']])
    const log = watch(doc)
    const cursor = changesSince(log, undefined, ALL).cursor
    const self = { uid: 7, via: 'Claude' }

    const { threadId } = asAgent(doc, () =>
      applyComment(doc, ACTOR, { blockId: 'b-1', text: 'Fixed it.' }))
    // The human accepts it, in their own connection's transaction.
    Y.transact(doc, () => {
      recordCommentMessage(doc, 'b-1', threadId, 'm-r', { uid: 9, at: Date.now(), resolved: true })
    }, { source: 'connection', connection: { context: { user: { uid: 9 } } } })

    const events = changesSince(log, cursor, ALL, self).events
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'comments', thread: { threadId, resolved: true }, by: { uid: 9 } })
  })

  it('tells the agent a thread was handed to it — an assignment is a comments event', () => {
    const doc = documentWith([['b-1', 'first']])
    const log = watch(doc)
    const cursor = changesSince(log, undefined, ALL).cursor
    const self = { uid: 7, via: 'Claude' }

    const { threadId } = asAgent(doc, () =>
      applyComment(doc, ACTOR, { blockId: 'b-1', text: 'Anything else?' }))
    Y.transact(doc, () => {
      recordCommentMessage(doc, 'b-1', threadId, 'm-x', {
        uid: 9,
        name: 'Bob',
        at: Date.now(),
        assignee: { uid: 7, name: 'fago', via: 'Claude' },
      })
    }, { source: 'connection', connection: { context: { user: { uid: 9 } } } })

    const events = changesSince(log, cursor, ALL, self).events
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'comments',
      thread: { threadId, assignee: { uid: 7, name: 'fago', via: 'Claude' } },
      by: { uid: 9 },
    })
  })

  it('reports a post that was assigned as one event, carrying the assignee', () => {
    const doc = documentWith([['b-1', 'first']])
    const log = watch(doc)
    const cursor = changesSince(log, undefined, ALL).cursor

    // The composer writes the opening message and the assignment together, the
    // way postComment does: two transactions would report the thread twice.
    Y.transact(doc, () => {
      recordCommentMessage(doc, 'b-1', 'c-1', 'm-a', {
        uid: 9, name: 'Bob', at: Date.now(), text: 'Can you check this?',
      })
      recordCommentMessage(doc, 'b-1', 'c-1', 'm-b', {
        uid: 9, name: 'Bob', at: Date.now(), assignee: { uid: 7, name: 'fago', via: 'Claude' },
      })
    }, { source: 'connection', connection: { context: { user: { uid: 9 } } } })

    const events = changesSince(log, cursor, ALL, { uid: 7, via: 'Claude' }).events
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'comments',
      thread: { threadId: 'c-1', assignee: { uid: 7, name: 'fago', via: 'Claude' } },
    })
  })

  it('refuses a cursor that is not shaped like one it handed out', () => {
    expect(isCursorShaped('a1b2:0:1789552000000')).toBe(true)
    expect(isCursorShaped('a1b2:0')).toBe(false)
    expect(isCursorShaped('a1b2::1789552000000')).toBe(false)
    expect(isCursorShaped('a1b2:-1:1789552000000')).toBe(false)
    expect(isCursorShaped('nonsense')).toBe(false)
  })

  it('says how many editors are in the room, so quiet and empty differ', async () => {
    const doc = documentWith([['b-1', 'first']])
    const log = watch(doc)

    expect(changesSince(log, undefined, ALL).editors).toBe(1)
    humans = 0
    expect(changesSince(log, undefined, ALL).editors).toBe(0)
  })

  it('answers the moment something happens, and empty-handed at the timeout', async () => {
    const doc = documentWith([['b-1', 'first']])
    const log = watch(doc)
    const { cursor } = changesSince(log, undefined, ALL)

    const waiting = awaitChanges(log, cursor, ALL, 5_000)
    applyComment(doc, ACTOR, { blockId: 'b-1', text: 'Now.' })
    expect((await waiting).events).toHaveLength(1)

    const timedOut = await awaitChanges(log, cursor, ['presence'], 20)
    expect(timedOut.events).toEqual([])
  })

  it('a timeout of zero answers from the log and waits for nothing', async () => {
    const doc = documentWith([['b-1', 'first']])
    const log = watch(doc)
    const { cursor } = changesSince(log, undefined, ALL)
    const setTimer = vi.fn()

    const quiet = await awaitChanges(log, cursor, ALL, 0, {}, { setTimer })
    expect(quiet.events).toEqual([])
    expect(setTimer).not.toHaveBeenCalled()
    expect(log.waiters.size).toBe(0)

    applyComment(doc, ACTOR, { blockId: 'b-1', text: 'Since you asked.' })

    expect((await awaitChanges(log, quiet.cursor, ALL, 0)).events).toHaveLength(1)
  })

  it('a wait is not woken by an event the reader filtered out', async () => {
    const doc = documentWith([['b-1', 'first']])
    const log = watch(doc)
    const { cursor } = changesSince(log, undefined, ALL)

    const waiting = awaitChanges(log, cursor, ['presence'], 80)
    applyComment(doc, ACTOR, { blockId: 'b-1', text: 'Not for you.' })

    expect((await waiting).events).toEqual([])
  })

  it('ends the loop when the last editor leaves', async () => {
    const doc = documentWith([['b-1', 'first']])
    const log = watch(doc)
    const { cursor } = changesSince(log, undefined, ALL)

    humans = 0
    joinPeer(doc, 104, 'editor1', 'b-1')
    await settled()

    expect(seen(log, cursor).at(-1)).toMatchObject({ kind: 'session', event: 'closed', reason: 'no-editors' })
  })

  it('ends the loop when the document goes, and stops watching with it', async () => {
    const doc = documentWith([['b-1', 'first']])
    const log = watch(doc)
    const { cursor } = changesSince(log, undefined, ALL)

    doc.destroy()

    expect(seen(log, cursor)).toEqual([
      expect.objectContaining({ kind: 'session', event: 'closed', reason: 'unloaded' }),
    ])
    expect(log.closed).toBe(true)
    // A wait on a closed log answers rather than hanging on a document that
    // no longer exists.
    expect((await awaitChanges(log, cursor, ALL, 5_000)).events).toHaveLength(1)
  })

  it('a wait ends when its client goes away, without burning the timeout', async () => {
    const doc = documentWith([['b-1', 'first']])
    const log = watch(doc)
    const { cursor } = changesSince(log, undefined, ALL)
    const gone = new AbortController()

    const waiting = awaitChanges(log, cursor, ALL, 5_000, {}, { signal: gone.signal })
    gone.abort()

    expect((await waiting).events).toEqual([])
    expect(log.waiters.size).toBe(0)
  })

  it('ends the loop on the room the last watcher asked about, not the first', async () => {
    const doc = documentWith([['b-1', 'first']])
    watch(doc)
    // The session that started the log has left; another agent is still reading.
    let stillThere = 1
    const log = watchSession({ documentName: 'node:1', doc, humanPeers: () => stillThere }, FAST)

    const { cursor } = changesSince(log, undefined, ALL)

    stillThere = 0
    joinPeer(doc, 42, 'editor2')
    await settled()

    expect(seen(log, cursor).some(event => event.kind === 'session')).toBe(true)
  })

  it('one watch per document, however many agents are watching it', () => {
    const doc = documentWith([['b-1', 'first']])
    expect(watch(doc)).toBe(watch(doc))
    // And it counts the room through whoever asked last: the session that
    // started the log may be gone while another still reads it.
    const log = watchSession({ documentName: 'node:1', doc, humanPeers: () => 4 }, FAST)
    expect(changesSince(log, undefined, ALL).editors).toBe(4)
  })
})
