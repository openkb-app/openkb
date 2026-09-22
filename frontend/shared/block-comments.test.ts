import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  commentsRoot,
  messageKey,
  mintCommentId,
  openThreads,
  parseMessageKey,
  pruneComments,
  readThreads,
  recordCommentMessage,
  resolveAnchor,
  type CommentMessage,
} from './block-comments'
import { readBlockMeta, recordContribution, serializeBlockMeta } from './page-blocks'

const AT = 1_700_000_000_000

function said(text: string, at: number, extra: Record<string, unknown> = {}): CommentMessage {
  return { uid: 7, name: 'Ada', at, text, ...extra }
}

/** A document holding exactly these messages, keyed as the model stores them. */
function docWith(messages: Record<string, CommentMessage>): Y.Doc {
  const doc = new Y.Doc()
  for (const [key, message] of Object.entries(messages)) {
    const [blockId, threadId, msgId] = key.split('/') as [string, string, string]
    recordCommentMessage(doc, blockId, threadId, msgId, message)
  }
  return doc
}

describe('comment keys', () => {
  it('round-trips a block, thread and message id through one key', () => {
    const key = messageKey('b-1', 'c-1', 'm-2')
    expect(parseMessageKey(key)).toEqual({ blockId: 'b-1', threadId: 'c-1', msgId: 'm-2' })
  })

  it('refuses a malformed key rather than guessing at it', () => {
    expect(parseMessageKey('b-1')).toBeNull()
    expect(parseMessageKey('b-1\u0000c-1')).toBeNull()
    expect(parseMessageKey('b-1\u0000c-1:m-2:extra')).toBeNull()
  })

  it('mints colon-free ids, so a key always splits back into three', () => {
    const id = mintCommentId('c', () => 0.5)
    expect(id).toMatch(/^c-[0-9a-f]{8}$/)
    expect(parseMessageKey(messageKey('b-1', id, mintCommentId('m', () => 0.25)))).not.toBeNull()
  })
})

describe('thread assembly', () => {
  it('orders a thread by when things were said, not by key', () => {
    const threads = readThreads(docWith({
      'b-1/c-1/m-b': said('and again', AT + 20),
      'b-1/c-1/m-a': said('first', AT),
    }))
    expect(threads).toHaveLength(1)
    expect(threads[0]!.messages.map(m => m.text)).toEqual(['first', 'and again'])
    expect(threads[0]!.openedAt).toBe(AT)
    expect(threads[0]!.lastAt).toBe(AT + 20)
  })

  it('carries the opening message anchor as the thread anchor', () => {
    const anchor = { from: 4, to: 9, quote: 'quick' }
    const [thread] = readThreads(docWith({
      'b-1/c-1/m-a': said('is it?', AT, { anchor }),
      'b-1/c-1/m-b': said('yes', AT + 5),
    }))
    expect(thread!.anchor).toEqual(anchor)
  })

  it('stands as the latest resolve message says, so reopening needs no second mechanism', () => {
    const opening = { 'b-1/c-1/m-a': said('look at this', AT) }
    expect(readThreads(docWith(opening))[0]!.resolved).toBe(false)

    const resolved = readThreads(docWith({
      ...opening,
      'b-1/c-1/m-r': { uid: 9, at: AT + 10, resolved: true },
    }))[0]!
    expect(resolved.resolved).toBe(true)

    const reopened = readThreads(docWith({
      ...opening,
      'b-1/c-1/m-r': { uid: 9, at: AT + 10, resolved: true },
      'b-1/c-1/m-s': { uid: 9, at: AT + 20, resolved: false },
    }))[0]!
    expect(reopened.resolved).toBe(false)
  })

  it('keeps a resolve out of the messages — it is a standing, not a thing said', () => {
    const [thread] = readThreads(docWith({
      'b-1/c-1/m-a': said('look at this', AT),
      'b-1/c-1/m-r': { uid: 9, at: AT + 10, resolved: true },
    }))
    expect(thread!.messages.map(m => m.text)).toEqual(['look at this'])
    expect(thread!.lastAt).toBe(AT + 10)
  })

  it('drops an entry that says nothing at all', () => {
    expect(readThreads(docWith({
      'b-1/c-1/m-r': { uid: 9, at: AT, resolved: true },
    }))).toEqual([])
  })

  it('reads every block\'s threads, and offers the open ones per block', () => {
    const all = readThreads(docWith({
      'b-1/c-1/m-a': said('one', AT),
      'b-2/c-2/m-a': said('two', AT + 1),
      'b-2/c-2/m-r': { uid: 9, at: AT + 2, resolved: true },
    }))
    expect(all.map(t => t.blockId)).toEqual(['b-1', 'b-2'])
    expect(openThreads(all, 'b-2')).toEqual([])
    expect(openThreads(all, 'b-1')).toHaveLength(1)
  })

  it('keeps two threads on the same block apart', () => {
    const all = readThreads(docWith({
      'b-1/c-1/m-a': said('one', AT),
      'b-1/c-2/m-a': said('another', AT + 1),
    }))
    expect(all.map(t => t.threadId)).toEqual(['c-1', 'c-2'])
  })
})

describe('thread assignment', () => {
  const opening = { 'b-1/c-1/m-a': said('who owns this?', AT) }
  const ada = { uid: 7, name: 'Ada' }
  const bob = { uid: 9, name: 'Bob' }

  it('is nobody\'s until somebody says so', () => {
    const [thread] = readThreads(docWith(opening))
    expect(thread!.assignee).toBeNull()
    expect(thread!.assignedBy).toBeNull()
  })

  it('stands as the latest assignment says, so reassigning needs no second mechanism', () => {
    const [thread] = readThreads(docWith({
      ...opening,
      'b-1/c-1/m-x': { uid: 7, name: 'Ada', at: AT + 10, assignee: ada },
      'b-1/c-1/m-y': { uid: 7, name: 'Ada', at: AT + 20, assignee: bob },
    }))
    expect(thread!.assignee).toEqual(bob)
  })

  it('remembers everybody it named, so a message still reads by who it was about', () => {
    const [thread] = readThreads(docWith({
      ...opening,
      'b-1/c-1/m-x': { uid: 7, name: 'Ada', at: AT + 10, assignee: { uid: 7, name: 'Ada', via: 'Claude' } },
      'b-1/c-1/m-y': { uid: 7, name: 'Ada', at: AT + 20, assignee: bob },
      'b-1/c-1/m-z': { uid: 9, name: 'Bob', at: AT + 30, assignee: null },
    }))
    expect(thread!.assignee).toBeNull()
    expect(thread!.assignedTo).toEqual([{ uid: 7, name: 'Ada', via: 'Claude' }, bob])
  })

  it('unassigns on a null, rather than needing the message removed', () => {
    const [thread] = readThreads(docWith({
      ...opening,
      'b-1/c-1/m-x': { uid: 7, name: 'Ada', at: AT + 10, assignee: bob },
      'b-1/c-1/m-y': { uid: 9, name: 'Bob', at: AT + 20, assignee: null },
    }))
    expect(thread!.assignee).toBeNull()
    expect(thread!.assignedBy).toEqual({ name: 'Bob', via: null, at: AT + 20 })
  })

  it('names who assigned it, which is what the thread\'s log line reads', () => {
    const [thread] = readThreads(docWith({
      ...opening,
      'b-1/c-1/m-x': { uid: 7, name: 'Ada', at: AT + 10, assignee: { uid: 9, name: 'Bob', via: 'Claude' } },
    }))
    expect(thread!.assignedBy).toEqual({ name: 'Ada', via: null, at: AT + 10 })
    expect(thread!.assignee).toEqual({ uid: 9, name: 'Bob', via: 'Claude' })
  })

  it('keeps an assignment out of the messages — it is a standing, not a thing said', () => {
    const [thread] = readThreads(docWith({
      ...opening,
      'b-1/c-1/m-x': { uid: 7, name: 'Ada', at: AT + 10, assignee: bob },
    }))
    expect(thread!.messages.map(m => m.text)).toEqual(['who owns this?'])
    expect(thread!.lastAt).toBe(AT + 10)
  })
})

describe('anchor resolution', () => {
  const anchor = { from: 4, to: 9, quote: 'quick' }

  it('holds where the stored offsets still read as the quoted words', () => {
    expect(resolveAnchor(anchor, 'The quick brown fox')).toEqual({ from: 4, to: 9 })
  })

  it('follows the quote when an edit elsewhere in the block moved it', () => {
    expect(resolveAnchor(anchor, 'Well, the quick brown fox')).toEqual({ from: 10, to: 15 })
  })

  it('degrades to block-level when the quoted words are gone', () => {
    expect(resolveAnchor(anchor, 'The slow brown fox')).toBeNull()
  })

  it('is block-level for a thread opened without a passage', () => {
    expect(resolveAnchor(null, 'The quick brown fox')).toBeNull()
  })
})

describe('a comment merges instead of clobbering', () => {
  it('keeps both replies when two peers answer the same thread at once', () => {
    const a = new Y.Doc()
    const b = new Y.Doc()
    recordCommentMessage(a, 'b-1', 'c-1', 'm-open', said('what about this?', AT))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))

    recordCommentMessage(a, 'b-1', 'c-1', 'm-ada', said('I think so', AT + 10))
    recordCommentMessage(b, 'b-1', 'c-1', 'm-bob', { uid: 8, name: 'Bob', at: AT + 11, text: 'I do not' })
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))

    for (const doc of [a, b]) {
      const [thread] = readThreads(doc)
      expect(thread!.messages.map(m => m.text)).toEqual(['what about this?', 'I think so', 'I do not'])
    }
  })

  it('leaves a concurrent message on the same block standing', () => {
    // Two peers write into one block's map concurrently — flat per-message
    // keys merge instead of clobbering.
    const a = new Y.Doc()
    const b = new Y.Doc()
    recordCommentMessage(a, 'b-1', 'c-1', 'm-1', said('needs a source'))
    recordCommentMessage(b, 'b-1', 'c-2', 'm-1', said('and a diagram'))
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))

    const threads = readThreads(a, 'b-1')
    expect(threads).toHaveLength(2)
  })
})

describe('a comment is not gate data', () => {
  it('writes nothing into the review sidecar, which is Drupal\'s alone to fill', () => {
    const doc = new Y.Doc()
    recordCommentMessage(doc, 'b-1', 'c-1', 'm-a', said('this claim needs a source', AT))
    // The sidecar is what a commit serializes into `field_block_meta`, and what
    // both the publish gate and the read page's byline projection are derived
    // from. A comment leaves it empty, so it can reach none of the three.
    expect(readBlockMeta(doc)).toEqual({})
    expect(serializeBlockMeta(readBlockMeta(doc))).toBe('')
  })

  it('is swept with the block it was about, like the sidecar entry beside it', () => {
    const doc = docWith({
      'b-1/c-1/m-a': said('still here', AT),
      'b-gone/c-2/m-a': said('about a deleted block', AT + 1),
    })
    pruneComments(doc, new Set(['b-1']))
    expect(readThreads(doc).map(t => t.blockId)).toEqual(['b-1'])
    expect([...commentsRoot(doc).keys()]).toHaveLength(1)
  })
})
