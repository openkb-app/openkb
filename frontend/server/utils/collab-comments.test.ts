import { describe, expect, it } from 'vitest'
import { readThreads, recordCommentMessage, type InlineCommentRecord } from '#shared/block-comments'
import * as Y from 'yjs'
import {
  commentRecords,
  commentsSynced,
  seedComments,
  META_NODE_UUID,
} from './collab-comments'

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
