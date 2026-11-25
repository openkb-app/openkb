import { describe, expect, it } from 'vitest'
import type { CommentThread, StoredMessage } from '#shared/block-comments'
import {
  awaitsChat,
  chatAssignee,
  chatReplied,
  chatTurnContext,
  chatTurnText,
  firstLapseOfTakeOnThreadAwaitingChat,
  needsHandBack,
  nextForChat,
  turnKey,
} from './chat-comments'

const AT = 1_754_000_000_000
const CHAT = chatAssignee({ uid: 7, name: 'editor1' })

function message(id: string, over: Partial<StoredMessage> = {}): StoredMessage {
  return { id, uid: 7, name: 'editor1', at: AT, text: 'shorten this', ...over }
}

function thread(threadId: string, over: Partial<CommentThread> = {}): CommentThread {
  return {
    blockId: 'b-1',
    threadId,
    anchor: null,
    messages: [message('m-1')],
    resolved: false,
    assignee: CHAT,
    assignedTo: [CHAT],
    assignedBy: { uid: 7, name: 'editor1', via: null, at: AT },
    handling: null,
    openedAt: AT,
    lastAt: AT,
    ...over,
  }
}

describe('which threads wait on the chat', () => {
  it('waits on an open thread assigned to the chat', () => {
    expect(awaitsChat(thread('c-1'), 7)).toBe(true)
  })

  it('does not wait on another account\'s chat, another agent, a person, or a resolved thread', () => {
    // Also covers: the chat as an assignee is the account's own, through the
    // chat client only.
    expect(awaitsChat(thread('c-1', { assignee: chatAssignee({ uid: 9, name: 'editor2' }) }), 7)).toBe(false)
    expect(awaitsChat(thread('c-1', { assignee: { uid: 7, name: 'editor1', via: 'Claude' } }), 7)).toBe(false)
    expect(awaitsChat(thread('c-1', { assignee: { uid: 7, name: 'editor1' } }), 7)).toBe(false)
    expect(awaitsChat(thread('c-1', { resolved: true }), 7)).toBe(false)
  })

  it('is done once an agent of the account replied, whatever its label, and waits again on the next message', () => {
    // Also covers: a relabelled chat client does not loop on its own reply.
    const replied = thread('c-1', { messages: [message('m-1'), message('m-2', { via: 'Our assistant' })] })
    expect(awaitsChat(replied, 7)).toBe(false)
    const again = thread('c-1', { messages: [...replied.messages, message('m-3', { text: 'shorter' })] })
    expect(awaitsChat(again, 7)).toBe(true)
  })

  it('is never started by another account', () => {
    const byOther = { uid: 9, name: 'editor2', via: null, at: AT }
    expect(awaitsChat(thread('c-1', { assignedBy: byOther }), 7)).toBe(false)
    expect(awaitsChat(thread('c-1', { assignedBy: { ...byOther, uid: 7, via: 'Claude' } }), 7)).toBe(true)
    const otherReplied = thread('c-1', { messages: [message('m-1'), message('m-2', { uid: 9, name: 'editor2' })] })
    expect(awaitsChat(otherReplied, 7)).toBe(false)
  })
})

describe('the next thread for the chat', () => {
  it('skips a thread a live tab holds, and takes it once the take lapsed', () => {
    const held = thread('c-1', { handling: { tab: 'tab-b', at: AT } })
    expect(nextForChat([held], 7, AT + 1000, new Set())).toBe(null)
    expect(nextForChat([held], 7, AT + 5 * 60_000, new Set())).toBe(held)
  })

  it('looks again when the first take on a waiting thread lapses', () => {
    // Also covers: a take on a thread that no longer waits wakes nothing.
    const held = thread('c-1', { handling: { tab: 'tab-b', at: AT } })
    const later = thread('c-2', { handling: { tab: 'tab-c', at: AT + 1000 } })
    const answered = thread('c-3', { handling: { tab: 'tab-d', at: AT - 1000 }, resolved: true })
    expect(firstLapseOfTakeOnThreadAwaitingChat([later, held, answered], 7, AT + 10)).toBe(AT + 5 * 60_000)
    expect(firstLapseOfTakeOnThreadAwaitingChat([held], 7, AT + 5 * 60_000)).toBe(null)
  })

  it('asks once per message', () => {
    const first = thread('c-1')
    const second = thread('c-2')
    expect(nextForChat([first, second], 7, AT, new Set([turnKey(first)]))).toBe(second)
    expect(turnKey(first)).not.toBe(turnKey(thread('c-1', { messages: [message('m-1'), message('m-2')] })))
  })
})

describe('the turn the chat is sent', () => {
  it('reads as the review comment: the passage and what was said', () => {
    // Also covers: the turn is the reader's request only, with no ids, no
    // tool name and no orders to the model.
    const text = chatTurnText(thread('c-1', {
      anchor: { from: 0, to: 9, quote: 'The quick' },
      messages: [message('m-1'), message('m-2', { uid: 3, name: 'fago', via: 'Claude', text: 'agreed' })],
    }))
    expect(text).toBe([
      'Review comment on "The quick":',
      'editor1: shorten this',
      'fago via Claude: agreed',
    ].join('\n'))
    expect(chatTurnText(thread('c-1'))).toBe('Review comment:\neditor1: shorten this')
  })

  it('carries the thread in the caller context', () => {
    expect(chatTurnContext(thread('c-1'))).toEqual({ commentThread: { block: 'b-1', threadId: 'c-1' } })
  })
})

describe('a turn that ended', () => {
  const before = new Set(['m-1'])
  const reply = message('m-2', { via: 'AI assistant', text: 'Shortened it.' })

  it('counts a new agent write of the account as the chat\'s reply', () => {
    expect(chatReplied(thread('c-1', { messages: [message('m-1'), reply] }), 7, before)).toBe(true)
    // Another account's agent, or the reader in person, is no reply.
    expect(chatReplied(thread('c-1', { messages: [message('m-1'), { ...reply, uid: 9 }] }), 7, before)).toBe(false)
    expect(chatReplied(thread('c-1', { messages: [message('m-1'), message('m-2')] }), 7, before)).toBe(false)
    // A reply from before the turn is not this turn's.
    expect(chatReplied(thread('c-1', { messages: [reply] }), 7, new Set(['m-2']))).toBe(false)
  })

  const taken = { handling: { tab: 't-a', at: AT } }

  it('hands back an open thread still with the chat, unless the chat replied or the reader wrote in it', () => {
    // Also covers: a message the reader writes during the turn goes to the
    // chat next.
    expect(needsHandBack(thread('c-1', taken), 7, before, 't-a')).toBe(true)
    expect(needsHandBack(thread('c-1', { ...taken, messages: [message('m-1'), reply] }), 7, before, 't-a')).toBe(false)
    const more = message('m-2', { text: 'and keep the example' })
    expect(needsHandBack(thread('c-1', { ...taken, messages: [message('m-1'), more] }), 7, before, 't-a')).toBe(false)
  })

  it('leaves a thread the reader resolved, reassigned or that is gone', () => {
    expect(needsHandBack(thread('c-1', { ...taken, resolved: true }), 7, before, 't-a')).toBe(false)
    expect(needsHandBack(thread('c-1', { ...taken, assignee: { uid: 7, name: 'editor1' } }), 7, before, 't-a')).toBe(false)
    expect(needsHandBack(undefined, 7, before, 't-a')).toBe(false)
  })

  it('leaves a thread another tab took after this tab\'s take lapsed, or that nobody holds', () => {
    expect(needsHandBack(thread('c-1', { handling: { tab: 't-b', at: AT } }), 7, before, 't-a')).toBe(false)
    expect(needsHandBack(thread('c-1'), 7, before, 't-a')).toBe(false)
  })
})
