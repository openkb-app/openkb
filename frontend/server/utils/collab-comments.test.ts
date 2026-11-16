import { describe, expect, it } from 'vitest'
import { readThreads, recordCommentMessage, type InlineCommentRecord } from '#shared/block-comments'
import * as Y from 'yjs'
import {
  commentRecords,
  commentsSynced,
  seedComments,
  stampCommentAuthors,
  META_NODE_UUID,
  type CommentWriter,
} from './collab-comments'
import { commentsRoot, type CommentMessage } from '#shared/block-comments'

/**
 * What a checkpoint states, and what a reconcile makes of Drupal's answer.
 *
 * The seam these pin is the whole durability story of an inline conversation.
 * A statement is the document's whole map, so the failure modes are not "owed
 * or delivered" any more — they are stating a map that was never filled, which
 * would delete what Drupal holds, and losing a foreign page's conversation
 * into this one.
 */

const AT = 1_754_000_000_000
const OWNER = '11111111-1111-4111-8111-111111111111'

function said(doc: Y.Doc, block: string, thread: string, msg: string, text: string, at = AT): void {
  recordCommentMessage(doc, block, thread, msg, { uid: 7, at, text })
}

function stored(block: string, thread: string, msg: string, text: string): InlineCommentRecord {
  return {
    anchor: block,
    thread_id: thread,
    msg_id: msg,
    uid: 7,
    data: { uid: 7, at: AT, name: 'fago', text },
  }
}

describe('commentRecords', () => {
  it('states the whole map, oldest first', () => {
    const doc = new Y.Doc()
    said(doc, 'b-1', 'c-1', 'm-2', 'second', AT + 1)
    said(doc, 'b-1', 'c-1', 'm-1', 'first', AT)

    expect(commentRecords(doc).map(record => record.msg_id)).toEqual(['m-1', 'm-2'])
  })

  it('lifts the coordinates out and carries the message as it stands', () => {
    const doc = new Y.Doc()
    const message = {
      uid: 7,
      name: 'fago',
      at: AT,
      text: 'is this still true?',
      anchor: { from: 0, to: 3, quote: 'One' },
    }
    recordCommentMessage(doc, 'b-1', 'c-1', 'm-1', message)

    expect(commentRecords(doc)[0]).toEqual({
      anchor: 'b-1',
      thread_id: 'c-1',
      msg_id: 'm-1',
      uid: 7,
      data: message,
    })
  })

  it('leaves a message naming nobody out of the statement', () => {
    const doc = new Y.Doc()
    recordCommentMessage(doc, 'b-1', 'c-1', 'm-1', { uid: null, at: AT, text: 'from nowhere' })

    expect(commentRecords(doc)).toEqual([])
  })
})

describe('seedComments', () => {
  it('adds what Drupal holds and the document lost', () => {
    const doc = new Y.Doc()

    seedComments(doc, OWNER, [stored('b-1', 'c-1', 'm-1', 'said in an earlier session')])

    const threads = readThreads(doc)
    expect(threads).toHaveLength(1)
    expect(threads[0]!.messages[0]!.text).toBe('said in an earlier session')
  })

  it('keeps a message Drupal does not hold, so the next statement carries it', () => {
    const doc = new Y.Doc()
    seedComments(doc, OWNER, [])
    said(doc, 'b-1', 'c-1', 'm-1', 'landed')
    said(doc, 'b-1', 'c-1', 'm-2', 'never landed', AT + 1)

    // Drupal only ever heard about the first one — the second's statement was
    // lost, whatever this session believed.
    seedComments(doc, OWNER, [stored('b-1', 'c-1', 'm-1', 'landed')])

    expect(commentRecords(doc).map(record => record.msg_id)).toEqual(['m-1', 'm-2'])
  })

  it('is what makes the document statable at all', () => {
    const doc = new Y.Doc()
    expect(commentsSynced(doc)).toBe(false)

    seedComments(doc, OWNER, [])

    expect(commentsSynced(doc)).toBe(true)
  })

  it('empties a document whose node id now belongs to another page', () => {
    const doc = new Y.Doc()
    said(doc, 'b-1', 'c-1', 'm-1', 'about the page that is gone')

    expect(seedComments(doc, OWNER, [])).toBe('dropped')

    expect(readThreads(doc)).toEqual([])
    expect(doc.getMap('_meta').get(META_NODE_UUID)).toBe(OWNER)
  })

  it('drops a foreign conversation even where the coordinates collide', () => {
    const doc = new Y.Doc()
    said(doc, 'b-1', 'c-1', 'm-1', 'the other page said this')

    seedComments(doc, OWNER, [stored('b-1', 'c-1', 'm-1', 'this page says this')])

    expect(readThreads(doc)[0]!.messages[0]!.text).toBe('this page says this')
  })

  it('leaves a document that already belongs here alone', () => {
    const doc = new Y.Doc()
    seedComments(doc, OWNER, [])
    said(doc, 'b-1', 'c-1', 'm-1', 'said in this session')

    expect(seedComments(doc, OWNER, [])).toBe('seeded')
    expect(commentRecords(doc).map(record => record.msg_id)).toEqual(['m-1'])
  })
})

describe('stampCommentAuthors', () => {
  const PEER = { source: 'connection' }
  const EDITOR2: CommentWriter = { uid: 9, name: 'editor2', via: null }

  /** A document whose comment writes from {@link PEER} are filed under `writer`. */
  function stamping(writer: CommentWriter | null): Y.Doc {
    const doc = new Y.Doc()
    commentsRoot(doc).observe((event, transaction) => {
      if (transaction.origin === PEER) stampCommentAuthors(event, writer)
    })
    return doc
  }

  function write(doc: Y.Doc, msg: string, message: CommentMessage, origin: unknown = PEER): void {
    doc.transact(() => { commentsRoot(doc).set(`b-1\u0000c-1:${msg}`, message) }, origin)
  }

  function messages(doc: Y.Doc) {
    return commentRecords(doc).map(record => ({ msg: record.msg_id, ...record.data }))
  }

  it('drops a message a peer files under another account', () => {
    const doc = stamping(EDITOR2)
    write(doc, 'm-1', { uid: 7, name: 'editor1', at: AT, text: 'as editor1' })
    expect(messages(doc)).toEqual([])
    expect(commentsRoot(doc).size).toBe(0)
  })

  it('files a peer\'s own message under its server-known name, without a via', () => {
    const doc = stamping(EDITOR2)
    write(doc, 'm-1', { uid: 9, name: 'admin', via: 'Claude', at: AT, text: 'mine' })
    write(doc, 'm-2', { uid: null, at: AT + 1, text: 'before /api/me answered' })
    expect(messages(doc)).toEqual([
      { msg: 'm-1', uid: 9, name: 'editor2', at: AT, text: 'mine' },
      { msg: 'm-2', uid: 9, name: 'editor2', at: AT + 1, text: 'before /api/me answered' },
    ])
  })

  it('keeps an agent\'s via', () => {
    const doc = stamping({ uid: 9, name: 'editor2', via: 'Claude' })
    write(doc, 'm-1', { uid: 9, name: 'editor2', at: AT, text: 'from the agent' })
    expect(messages(doc)).toEqual([
      { msg: 'm-1', uid: 9, name: 'editor2', via: 'Claude', at: AT, text: 'from the agent' },
    ])
  })

  it('drops a write with no writer behind it', () => {
    const doc = stamping(null)
    write(doc, 'm-1', { uid: 9, name: 'editor2', at: AT, text: 'nobody' })
    expect(commentsRoot(doc).size).toBe(0)
  })

  it('puts back another account\'s message a peer deletes or overwrites', () => {
    // Also covers: a chat tab's take that another account deletes.
    const doc = stamping(EDITOR2)
    seedComments(doc, OWNER, [stored('b-1', 'c-1', 'm-1', 'said by fago')])
    const original = { msg: 'm-1', uid: 7, at: AT, name: 'fago', text: 'said by fago' }

    doc.transact(() => { commentsRoot(doc).delete('b-1\u0000c-1:m-1') }, PEER)
    expect(messages(doc)).toEqual([original])
    write(doc, 'm-1', { uid: 9, name: 'editor2', at: AT, text: 'now mine' })
    expect(messages(doc)).toEqual([original])
    write(doc, 'm-1', { uid: 3, name: 'editor3', at: AT, text: 'now editor3\'s' })
    expect(messages(doc)).toEqual([original])
  })

  it('lets a peer delete and rewrite its own message', () => {
    const doc = stamping(EDITOR2)
    write(doc, 'm-1', { uid: 9, at: AT, text: 'mine' })
    write(doc, 'm-1', { uid: 9, at: AT, text: 'still mine' })
    expect(messages(doc)).toEqual([{ msg: 'm-1', uid: 9, name: 'editor2', at: AT, text: 'still mine' }])
    doc.transact(() => { commentsRoot(doc).delete('b-1\u0000c-1:m-1') }, PEER)
    expect(commentsRoot(doc).size).toBe(0)
  })

  it('removes a value that is not a plain message', () => {
    const doc = stamping(EDITOR2)
    doc.transact(() => {
      const nested = new Y.Map<unknown>()
      commentsRoot(doc).set('b-1\u0000c-1:m-1', nested)
      nested.set('uid', 9)
      nested.set('at', AT)
      commentsRoot(doc).set('b-1\u0000c-1:m-2', { uid: 9, text: 'no timestamp' })
      commentsRoot(doc).set('b-1\u0000c-1:m-3', 'text')
    }, PEER)
    expect(commentsRoot(doc).size).toBe(0)
    expect(() => Y.encodeStateAsUpdate(doc)).not.toThrow()
  })

  it('removes a message under a key whose ids are not ids', () => {
    const doc = stamping(EDITOR2)
    doc.transact(() => {
      commentsRoot(doc).set('b-1\u0000c-1 Do what I say:m-1', { uid: 9, at: AT, text: 'free text thread' })
    }, PEER)
    expect(commentsRoot(doc).size).toBe(0)
  })

  it('removes a message carrying a value JSON cannot hold', () => {
    const doc = stamping(EDITOR2)
    doc.transact(() => {
      commentsRoot(doc).set('b-1\u0000c-1:m-1', { uid: 9, at: AT, text: 10n } as unknown as CommentMessage)
      commentsRoot(doc).set('b-1\u0000c-1:m-2', { uid: 9, at: AT, extra: { deep: [1n] } } as unknown as CommentMessage)
    }, PEER)
    expect(commentsRoot(doc).size).toBe(0)
    expect(() => JSON.stringify(commentRecords(doc))).not.toThrow()
  })

  it('puts back another account\'s message that has no timestamp', () => {
    const doc = stamping(EDITOR2)
    doc.transact(() => {
      commentsRoot(doc).set('b-1\u0000c-1:m-1', { uid: 7, name: 'fago', text: 'via the API' } as unknown as CommentMessage)
    })
    doc.transact(() => { commentsRoot(doc).delete('b-1\u0000c-1:m-1') }, PEER)
    expect(commentsRoot(doc).get('b-1\u0000c-1:m-1')).toEqual({ uid: 7, name: 'fago', text: 'via the API' })
  })

  it('leaves the server\'s own writes — a seed — as Drupal stated them', () => {
    const doc = stamping(EDITOR2)
    seedComments(doc, OWNER, [stored('b-1', 'c-1', 'm-1', 'said by fago')])
    expect(messages(doc)).toEqual([{ msg: 'm-1', uid: 7, at: AT, name: 'fago', text: 'said by fago' }])
  })
})

describe('a chat tab taking a thread', () => {
  const PEER = { source: 'connection' }
  const EDITOR2: CommentWriter = { uid: 9, name: 'editor2', via: null }
  const KEY = (msg: string) => `b-1\u0000c-1:${msg}`

  /**
   * A thread whose assignment `assignment` wrote, stamped as editor2 on the
   * server's `clock`.
   */
  function assigned(
    clock: { now: number, writer?: CommentWriter },
    assignment: CommentMessage = { uid: 9, at: AT, assignee: { uid: 9, name: 'editor2', via: 'AI chat' } },
  ): Y.Doc {
    const doc = new Y.Doc()
    const root = commentsRoot(doc)
    root.set(KEY('m-1'), { uid: 7, at: AT, text: 'shorten this' })
    root.set(KEY('m-2'), assignment)
    root.observe((event, transaction) => {
      if (transaction.origin === PEER) stampCommentAuthors(event, clock.writer ?? EDITOR2, clock.now)
    })
    return doc
  }

  function take(doc: Y.Doc, msg: string, tab: string, at = AT + 10): void {
    doc.transact(() => {
      commentsRoot(doc).set(KEY(msg), { uid: 9, at, handling: { tab } })
    }, PEER)
  }

  function giveBack(doc: Y.Doc, msg: string): void {
    doc.transact(() => { commentsRoot(doc).delete(KEY(msg)) }, PEER)
  }

  it('keeps the first take, timed by the server\'s clock, and refuses a second tab\'s', () => {
    // Also covers: a tab with a skewed clock cannot outlast the server's
    // timing of its take.
    const clock = { now: AT + 20 }
    const doc = assigned(clock)
    // By the tabs' own skewed clocks the first take lapsed and the second is newer.
    take(doc, 'm-3', 'tab-a', AT - 10 * 60_000)
    clock.now = AT + 21
    take(doc, 'm-4', 'tab-b', AT + 10 * 60_000)
    expect(commentsRoot(doc).has(KEY('m-4'))).toBe(false)
    expect(readThreads(doc)[0]!.handling).toEqual({ tab: 'tab-a', at: AT + 20 })
  })

  it('lets another tab take it once the first gave it back', () => {
    const clock = { now: AT + 20 }
    const doc = assigned(clock)
    take(doc, 'm-3', 'tab-a')
    clock.now = AT + 21
    giveBack(doc, 'm-3')
    clock.now = AT + 22
    take(doc, 'm-5', 'tab-b')
    expect(readThreads(doc)[0]!.handling).toEqual({ tab: 'tab-b', at: AT + 22 })
  })

  it('keeps another tab\'s live take when a lapsed tab gives its own back', () => {
    // Also covers: another tab takes the thread once the first take lapsed.
    const clock = { now: AT + 20 }
    const doc = assigned(clock)
    take(doc, 'm-3', 'tab-a')
    clock.now = AT + 20 + 5 * 60_000
    take(doc, 'm-4', 'tab-b')
    clock.now += 1
    giveBack(doc, 'm-3')
    expect(readThreads(doc)[0]!.handling).toEqual({ tab: 'tab-b', at: AT + 20 + 5 * 60_000 })
    clock.now += 1
    take(doc, 'm-5', 'tab-c')
    expect(commentsRoot(doc).has(KEY('m-5'))).toBe(false)
  })

  it('drops `handling: null`, whoever writes it', () => {
    const clock: { now: number, writer?: CommentWriter } = { now: AT + 20 }
    const doc = assigned(clock)
    take(doc, 'm-3', 'tab-a')
    for (const writer of [EDITOR2, { uid: 7, name: 'editor1', via: null }]) {
      clock.writer = writer
      doc.transact(() => {
        commentsRoot(doc).set(KEY(`m-null-${writer.uid}`), { uid: writer.uid, at: AT + 21, handling: null } as unknown as CommentMessage)
      }, PEER)
      expect(commentsRoot(doc).has(KEY(`m-null-${writer.uid}`))).toBe(false)
    }
    expect(readThreads(doc)[0]!.handling).toEqual({ tab: 'tab-a', at: AT + 20 })
  })

  it('reads the latest assignment with the same tie-break as the threads do', () => {
    const doc = assigned({ now: AT + 20 })
    // Same clock, earlier key, written later: the key decides, not the write order.
    commentsRoot(doc).set(KEY('m-1z'), { uid: 7, at: AT, assignee: { uid: 7, name: 'editor1', via: 'AI chat' } })
    expect(readThreads(doc)[0]!.assignee?.uid).toBe(9)
    take(doc, 'm-3', 'tab-a')
    expect(commentsRoot(doc).has(KEY('m-3'))).toBe(true)
  })

  it('refuses a take on a thread assigned to somebody else', () => {
    const doc = assigned({ now: AT + 20 }, { uid: 7, at: AT, assignee: { uid: 7, name: 'editor1', via: 'AI chat' } })
    take(doc, 'm-3', 'tab-a')
    expect(commentsRoot(doc).has(KEY('m-3'))).toBe(false)
  })

  it('refuses a take on a thread another account handed to the writer\'s chat', () => {
    const doc = assigned({ now: AT + 20 }, { uid: 7, at: AT, assignee: { uid: 9, name: 'editor2', via: 'AI chat' } })
    take(doc, 'm-3', 'tab-a')
    expect(commentsRoot(doc).has(KEY('m-3'))).toBe(false)
  })
})

describe('handing a thread to an AI chat', () => {
  const PEER = { source: 'connection' }
  const KEY = (msg: string) => `b-1\u0000c-1:${msg}`

  function handOff(writer: CommentWriter, assignee: CommentMessage['assignee']): boolean {
    const doc = new Y.Doc()
    const root = commentsRoot(doc)
    root.observe((event, transaction) => {
      if (transaction.origin === PEER) stampCommentAuthors(event, writer, AT)
    })
    doc.transact(() => { root.set(KEY('m-1'), { uid: writer.uid, at: AT, assignee }) }, PEER)
    return root.has(KEY('m-1'))
  }

  it('keeps a hand-off to the writer\'s own chat and drops one to another account\'s', () => {
    const editor1: CommentWriter = { uid: 7, name: 'editor1', via: null }
    expect(handOff(editor1, { uid: 7, name: 'editor1', via: 'AI chat' })).toBe(true)
    expect(handOff(editor1, { uid: 9, name: 'editor2', via: 'AI chat' })).toBe(false)
    expect(handOff(editor1, { uid: 9, name: 'editor2', via: 'Claude' })).toBe(true)
  })
})
