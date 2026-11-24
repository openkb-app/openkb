import { describe, expect, it } from 'vitest'
import type { CommentThread } from '#shared/block-comments'
import { nameThreadCurrently, relabelMentions, threadAccountUids } from './comment-threads'

const THREAD: CommentThread = {
  blockId: 'b-1',
  threadId: 'c-1',
  anchor: null,
  messages: [{ id: 'm-1', uid: 2, name: 'old-two', at: 1, text: 'ask :mention[old-three]{uid="3"} and :mention[gone]{uid="9"}' }],
  resolved: false,
  assignee: { uid: 3, name: 'old-three', via: 'claude' },
  assignedTo: [],
  assignedBy: null,
  handling: null,
  openedAt: 1,
  lastAt: 1,
}

describe('naming a thread as accounts are called now', () => {
  const names = new Map([[2, 'Two'], [3, 'Th[ree]']])

  it('collects every account the thread names', () => {
    expect(threadAccountUids(THREAD)).toEqual([2, 3, 3, 9])
  })

  it('relabels authors, the assignee and mentions, and keeps a label nobody answers for', () => {
    const named = nameThreadCurrently(THREAD, names)

    expect(named.messages[0]).toMatchObject({
      name: 'Two',
      text: 'ask :mention[Th\\[ree\\]]{uid="3"} and :mention[gone]{uid="9"}',
    })
    expect(named.assignee).toEqual({ uid: 3, name: 'Th[ree]', via: 'claude' })
  })

  it('labels an agent mention by its owner and the agent', () => {
    expect(relabelMentions(':mention[claude]{uid="2" via="claude"}', names))
      .toBe(':mention[Two via claude]{uid="2" via="claude"}')
  })

  it('leaves text without mentions alone', () => {
    expect(relabelMentions('plain @words', names)).toBe('plain @words')
  })
})
