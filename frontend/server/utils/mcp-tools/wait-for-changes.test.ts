import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap'
import {
  connect,
  resetMocks,
  drupalMock,
  drupalToolsMock,
  hocuspocusMock,
  kbReadMock,
  sessionRouterMock,
  joinAgentSession,
} from '../mcp-server.test-harness'
import { editorSchema } from '../editor-schema'
import { presenceCarrier, publishAwareness } from '../agent-awareness'
import { applyComment } from '../agent-peer'
import { stopAllWatches } from '../session-events'
import { recordCommentMessage } from '#shared/block-comments'
import type { AwareDoc } from '../agent-awareness'

/**
 * waitForChanges, driven through a real MCP client over a real document.
 *
 * The session it joins is stood in for — admission is the router's, tested
 * there — but the document underneath is a genuine Y.Doc, so what the tool
 * answers is what the derivation actually produced.
 */

vi.mock('../kb-read', () => kbReadMock)
vi.mock('../drupal', () => drupalMock)
vi.mock('../session-router', importOriginal => sessionRouterMock(importOriginal))
vi.mock('../hocuspocus', () => hocuspocusMock)
vi.mock('../drupal-tools', () => drupalToolsMock)

const ACTOR = { token: 'tok-1', uid: 7, name: 'fago', via: 'Claude' }
/** A person in the editor: same account is possible, an agent label is not. */
const HUMAN = { token: 'sess-1', uid: 3, name: 'editor1', via: null }

/** The session the router would hand back, over a document that really moves. */
function session(name = 'node:7', remainingMs = 60_000) {
  const doc = prosemirrorJSONToYDoc(editorSchema, {
    type: 'doc',
    content: [{ type: 'paragraph', attrs: { id: 'b-1' }, content: [{ type: 'text', text: 'first' }] }],
  } as never, 'default') as AwareDoc
  doc.awareness = new Awareness(doc)
  doc.awareness.setLocalState(null)
  // The tool counts editors off the document itself, the way a live one does.
  let editors: unknown[] = [{}]
  Object.assign(doc, { getConnections: () => editors })
  let seats = 0
  const held = {
    documentName: name,
    doc,
    clientId: 999,
    actor: ACTOR,
    humanPeers: () => editors.length,
    leaveRoom: () => {
      editors = []
    },
    /** Seats a call in flight is holding on the session right now. */
    seats: () => seats,
  }
  joinAgentSession.mockResolvedValue({
    session: held,
    keepAlive: () => {
      seats += 1
      return () => {
        seats -= 1
      }
    },
    remainingMs,
  })
  return held
}

describe('waitForChanges', () => {
  beforeEach(resetMocks)
  afterEach(stopAllWatches)

  it('answers as soon as a thread is opened, and the cursor resumes after it', async () => {
    // One millisecond for everything: the cursor shares it with the thread.
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    onTestFinished(() => now.mockRestore())
    const { doc } = session()
    const { client } = await connect()
    await client.listTools()

    const waiting = client.callTool({
      name: 'waitForChanges',
      arguments: { path: 'intro', timeoutSec: 5 },
    })
    // A human says something while the agent is waiting on the call.
    await new Promise(resolve => setTimeout(resolve, 20))
    applyComment(doc, HUMAN, { blockId: 'b-1', text: 'Can you add a source?' })

    const answer = await waiting
    const { events, cursor } = answer.structuredContent as any
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'comments',
      thread: { blockId: 'b-1', resolved: false, messages: [expect.objectContaining({ name: 'editor1' })] },
    })
    // The prose says the same thing, for a client that reads the text.
    expect((answer.content as any[])[0].text).toContain('Can you add a source?')

    // Resuming on the cursor answers what happened after it: nothing yet.
    const next = await client.callTool({
      name: 'waitForChanges',
      arguments: { path: 'intro', cursor, timeoutSec: 1 },
    })
    expect(next.structuredContent as any).toMatchObject({ events: [], editors: 1, restarted: false })
  })

  it('answers a first call with the threads waiting for it, without waiting', async () => {
    const { doc } = session()
    const { client } = await connect()
    await client.listTools()

    // Said before this caller arrived: one thread it owes an answer, one it
    // already answered, one somebody marked done.
    applyComment(doc, HUMAN, { blockId: 'b-1', text: 'Can you add a source?' })
    const answered = applyComment(doc, HUMAN, { blockId: 'b-1', text: 'And here?' })
    // A later millisecond: a reply in the same one has no defined order.
    recordCommentMessage(doc, 'b-1', answered.threadId, 'm-reply', { uid: ACTOR.uid, name: ACTOR.name, via: ACTOR.via, at: Date.now() + 1, text: 'Added it.' })
    const done = applyComment(doc, HUMAN, { blockId: 'b-1', text: 'Typo in line two.' })
    recordCommentMessage(doc, 'b-1', done.threadId, 'm-done', { uid: 3, at: Date.now(), resolved: true })

    const started = Date.now()
    const answer = await client.callTool({
      name: 'waitForChanges',
      arguments: { path: 'intro', kinds: ['comments'], timeoutSec: 30 },
    })
    const { events, cursor } = answer.structuredContent as any

    // It came back on the backlog, not on the timeout.
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(events.map((event: any) => event.thread.messages.at(-1).text)).toEqual(['Can you add a source?'])
    expect(events[0]).toMatchObject({ kind: 'comments', by: { name: 'editor1' } })

    // And the cursor it gave back is the log's, so the loop goes on from here.
    const next = await client.callTool({
      name: 'waitForChanges',
      arguments: { path: 'intro', kinds: ['comments'], cursor, timeoutSec: 1 },
    })
    expect((next.structuredContent as any).events).toEqual([])
  })

  it('carries a thread the log never witnessed, even from the cursor\'s own millisecond', async () => {
    const { doc } = session()
    const { client } = await connect()
    await client.listTools()

    const { cursor } = (await client.callTool({
      name: 'waitForChanges',
      arguments: { path: 'intro', kinds: ['comments'], timeoutSec: 1 },
    })).structuredContent as any

    // The log goes — a restarted process, a document reloaded — and the human
    // says something while nothing is observing.
    stopAllWatches()
    const at = Number(cursor.split(':')[2])
    recordCommentMessage(doc, 'b-1', 'c-unseen', 'm-unseen', { uid: HUMAN.uid, name: HUMAN.name, at, text: 'Said while nothing watched.' })

    const answer = (await client.callTool({
      name: 'waitForChanges',
      arguments: { path: 'intro', kinds: ['comments'], cursor, timeoutSec: 1 },
    })).structuredContent as any

    expect(answer.events.map((event: any) => event.thread.messages.at(-1).text))
      .toEqual(['Said while nothing watched.'])
    expect(answer.events[0]).toMatchObject({ kind: 'comments', by: { name: 'editor1' } })
  })

  it('ends the loop when the last editor leaves, and says the room is empty', async () => {
    const { doc, leaveRoom } = session()
    const { client } = await connect()
    await client.listTools()

    const waiting = client.callTool({
      name: 'waitForChanges',
      arguments: { path: 'intro', kinds: ['presence'], timeoutSec: 5 },
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    leaveRoom()
    // Awareness moving is what makes the watch re-count the room.
    publishAwareness(doc, presenceCarrier(101), 101, { user: { name: 'editor1', uid: 3 } }, null)

    // The wait answers on the first event of the settle; the close is the next.
    const { cursor } = (await waiting).structuredContent as any
    const next = await client.callTool({
      name: 'waitForChanges',
      arguments: { path: 'intro', cursor, timeoutSec: 5 },
    })

    const answer = next.structuredContent as any
    expect(answer.events).toEqual([
      expect.objectContaining({ kind: 'session', event: 'closed', reason: 'no-editors' }),
    ])
    expect(answer.editors).toBe(0)
  })

  it('holds a seat for the wait, and never waits past the session\'s age cap', async () => {
    // A wait long enough that only the cap can end it: the seat goes with the
    // session at the cap, so answering there is what gets it back — the next
    // call rejoins instead of watching a page it has no seat in.
    const { seats } = session('node:7', 200)
    const { client } = await connect()
    await client.listTools()

    const waiting = client.callTool({
      name: 'waitForChanges',
      arguments: { path: 'intro', timeoutSec: 120 },
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(seats()).toBe(1)

    const answer = (await waiting).structuredContent as any
    expect(answer.events).toEqual([])
    expect(answer.cursor).toBeTruthy()
    // Nothing of a finished call is left on a session that outlives it.
    expect(seats()).toBe(0)
  })

  it('does not report the agent its own message back to it', async () => {
    const { doc } = session()
    const { client } = await connect()
    await client.listTools()

    // The agent said this itself: hearing it back would re-trigger the loop.
    applyComment(doc, ACTOR, { blockId: 'b-1', text: 'Rewrote the intro.' })
    const answer = await client.callTool({
      name: 'waitForChanges',
      arguments: { path: 'intro', timeoutSec: 1 },
    })

    expect((answer.structuredContent as any).events).toEqual([])
  })

  it('reads a resolve as a resolve, and names who did it', async () => {
    const { doc } = session()
    const { client } = await connect()
    await client.listTools()

    // In the room before the watch starts, so the event can name them.
    publishAwareness(doc, presenceCarrier(101), 101, { user: { name: 'editor1', uid: 3 } }, null)
    const { threadId } = applyComment(doc, ACTOR, { blockId: 'b-1', text: 'Rewrote the intro.' })

    const waiting = client.callTool({
      name: 'waitForChanges',
      arguments: { path: 'intro', kinds: ['comments'], timeoutSec: 5 },
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    Y.transact(doc, () => {
      recordCommentMessage(doc, 'b-1', threadId, 'm-r', { uid: 3, at: Date.now(), resolved: true })
    }, { source: 'connection', connection: { context: { user: { uid: 3 } } } })

    const answer = await waiting
    const { events } = answer.structuredContent as any
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'comments', thread: { threadId, resolved: true }, by: { uid: 3, name: 'editor1' },
    })
    // A resolve carries no message: reading the thread's last text back would
    // hand the agent its own sentence with no sign the thread was accepted.
    const text = (answer.content as any[])[0].text
    expect(text).toContain(`thread ${threadId} on b-1 resolved, by editor1`)
    expect(text).not.toContain('Rewrote the intro.')
  })

  it('waits for the kinds it was asked for and no others', async () => {
    const { doc } = session()
    const { client } = await connect()
    await client.listTools()

    const waiting = client.callTool({
      name: 'waitForChanges',
      arguments: { path: 'intro', kinds: ['presence'], timeoutSec: 1 },
    })
    applyComment(doc, HUMAN, { blockId: 'b-1', text: 'Not what you asked for.' })

    expect(((await waiting).structuredContent as any).events).toEqual([])
  })

  it('answers at once when asked to wait for nothing, and resumes on the cursor', async () => {
    const { doc } = session()
    const { client } = await connect()
    await client.listTools()

    // The first call only marks the point in time; the log starts here.
    const first = await client.callTool({
      name: 'waitForChanges',
      arguments: { path: 'intro', timeoutSec: 0 },
    })
    expect(first.structuredContent as any).toMatchObject({ events: [], editors: 1 })
    expect((first.content as any[])[0].text).toContain('Nothing has happened')
    const { cursor } = first.structuredContent as any

    applyComment(doc, HUMAN, { blockId: 'b-1', text: 'Can you add a source?' })

    const next = await client.callTool({
      name: 'waitForChanges',
      arguments: { path: 'intro', cursor, timeoutSec: 0 },
    })
    const { events } = next.structuredContent as any
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'comments', thread: { blockId: 'b-1' } })
  })

  it('still advertises the agent wait as default 30 s, max 120 s', async () => {
    session()
    const { client } = await connect()

    const tool = (await client.listTools()).tools.find(t => t.name === 'waitForChanges')!
    expect((tool.inputSchema as any).properties.timeoutSec).toMatchObject({
      minimum: 0,
      maximum: 120,
    })
    expect((tool.inputSchema as any).properties.timeoutSec.description).toContain('default 30')
  })

  it('refuses a kind it does not serve, naming the ones it does', async () => {
    session()
    const { client } = await connect()
    await client.listTools()

    const res = await client.callTool({
      name: 'waitForChanges',
      arguments: { path: 'intro', kinds: ['revisions'] },
    })

    expect(res.isError).toBe(true)
    expect((res.structuredContent as any).message).toContain('comments, blocks, presence')
  })

  it('refuses a cursor it never handed out, rather than reading it as a lost log', async () => {
    session()
    const { client } = await connect()
    await client.listTools()

    const res = await client.callTool({
      name: 'waitForChanges',
      arguments: { path: 'intro', cursor: 'yesterday' },
    })

    expect(res.isError).toBe(true)
    expect((res.structuredContent as any).message).toContain('previous answer')
    expect(joinAgentSession).not.toHaveBeenCalled()
  })

  it('a refused join is a tool refusal, not a broken connection', async () => {
    const { AgentJoinError } = await import('../session-router')
    joinAgentSession.mockRejectedValue(new AgentJoinError('access', 'No write access to intro.'))
    const { client } = await connect()
    await client.listTools()

    const res = await client.callTool({ name: 'waitForChanges', arguments: { path: 'intro' } })

    expect(res.isError).toBe(true)
    expect((res.structuredContent as any).message).toBe('No write access to intro.')
    // The connection still works — the next call is served.
    expect((await client.listTools()).tools.map(t => t.name)).toContain('waitForChanges')
  })
})
