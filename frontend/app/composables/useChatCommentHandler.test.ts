import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, onScopeDispose, ref, shallowRef, watch } from 'vue'
import type { CommentThread } from '#shared/block-comments'
import type { LiveStatus } from '~/composables/useLiveCollab'
import { CHAT_HANDLING_TTL_MS } from '#shared/utils/chat-agent'
import { chatAssignee } from '~/editor/chat-comments'
import { useChatCommentHandler } from './useChatCommentHandler'

/**
 * The handler against a stubbed edit session, chat and pane, on fake timers:
 * when it takes a thread, and when it opens the chat for it.
 */

const CHAT = chatAssignee({ uid: 7, name: 'editor1' })

/** A thread waiting on editor1's assistant, with no take on it. */
function waiting(): CommentThread {
  return {
    blockId: 'b-1',
    threadId: 'c-1',
    anchor: null,
    messages: [{ id: 'm-1', uid: 7, name: 'editor1', at: Date.now(), text: 'shorten this' }],
    resolved: false,
    assignee: CHAT,
    assignedTo: [CHAT],
    assignedBy: { uid: 7, name: 'editor1', via: null, at: Date.now() },
    handling: null,
    openedAt: Date.now(),
    lastAt: Date.now(),
  }
}

const chatOpen = ref(false)
const wide = ref(true)
const openChatKeepingFocus = vi.fn(() => { chatOpen.value = true })
const ask = vi.fn(() => Promise.resolve())

/**
 * The waiting thread with another tab's take on it, stamped a take's lifetime
 * ago: lapsed by this tab's clock, live by the server's.
 */
function heldElsewhere(): CommentThread {
  return { ...waiting(), handling: { tab: 't-other', at: Date.now() - CHAT_HANDLING_TTL_MS } }
}

/** Starts the handler on a session that goes live with one waiting thread. */
async function start(
  takeForChat: (blockId: string, threadId: string, tab: string) => Promise<string | null>,
  thread: CommentThread = waiting(),
) {
  const liveStatus = ref<LiveStatus>('connecting')
  const session = shallowRef({
    threads: ref([thread]),
    liveStatus,
    takeForChat: vi.fn(takeForChat),
    giveBackFromChat: vi.fn(),
    handBackFromChat: vi.fn(),
  })
  const scope = effectScope()
  scope.run(() => useChatCommentHandler(session, ref(7)))
  liveStatus.value = 'live'
  await vi.advanceTimersByTimeAsync(0)
  return { session: session.value, scope }
}

beforeEach(() => {
  vi.useFakeTimers()
  chatOpen.value = false
  wide.value = true
  openChatKeepingFocus.mockClear()
  ask.mockClear()
  vi.stubGlobal('watch', watch)
  vi.stubGlobal('onScopeDispose', onScopeDispose)
  vi.stubGlobal('useSidePane', () => ({ chatOpen, wide, openChatKeepingFocus }))
  vi.stubGlobal('useChatPanelSession', () => ({ status: ref('ready') }))
  vi.stubGlobal('useChatAsk', () => ask)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the chat comment handler', () => {
  it('leaves a refused thread alone for a take\'s lifetime, then takes it again', async () => {
    // Only the server's refusal tells the tab another tab holds the thread.
    const { session, scope } = await start(() => Promise.resolve(null), heldElsewhere())
    expect(session.takeForChat).toHaveBeenCalledTimes(1)
    expect(openChatKeepingFocus).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(CHAT_HANDLING_TTL_MS - 1)
    expect(session.takeForChat).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(session.takeForChat).toHaveBeenCalledTimes(2)
    scope.stop()
  })

  it('takes a refused thread again once the take that refused it is gone', async () => {
    const takes = [null, 'take-1']
    const { session, scope } = await start(() => Promise.resolve(takes.shift() ?? null), heldElsewhere())
    expect(session.takeForChat).toHaveBeenCalledTimes(1)

    // The server ends the other tab's take: its connection closed.
    session.threads.value = [waiting()]
    await vi.advanceTimersByTimeAsync(0)
    expect(session.takeForChat).toHaveBeenCalledTimes(2)
    scope.stop()
  })

  it('opens the chat for a thread it took, and keeps it shut where the chat is a slideover', async () => {
    const { scope } = await start(() => Promise.resolve('take-1'))
    expect(openChatKeepingFocus).toHaveBeenCalledTimes(1)
    expect(ask).toHaveBeenCalledTimes(1)
    scope.stop()

    chatOpen.value = false
    wide.value = false
    openChatKeepingFocus.mockClear()
    ask.mockClear()
    const narrow = await start(() => Promise.resolve('take-2'))
    expect(openChatKeepingFocus).not.toHaveBeenCalled()
    expect(ask).toHaveBeenCalledTimes(1)
    narrow.scope.stop()
  })
})
