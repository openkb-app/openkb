import type { Ref } from 'vue'
import type { CommentThread } from '#shared/block-comments'
import { CHAT_HANDLING_TTL_MS } from '#shared/utils/chat-agent'
import type { LiveStatus } from '~/composables/useLiveCollab'
import {
  chatReplied,
  chatTurnContext,
  chatTurnText,
  firstLapseOfTakeOnThreadAwaitingChat,
  HAND_BACK_TEXT,
  needsHandBack,
  nextForChat,
  turnKey,
} from '~/editor/chat-comments'

/** What the handler needs of the edit session. */
interface ChatThreadSession {
  threads: Ref<CommentThread[]>
  liveStatus: Ref<LiveStatus>
  takeForChat: (blockId: string, threadId: string, tab: string) => Promise<string | null>
  giveBackFromChat: (blockId: string, threadId: string, msgId: string) => void
  handBackFromChat: (blockId: string, threadId: string, text: string) => void
}

/** This tab's id: what its takes name, so tabs of one account tell them apart. */
const TAB = `t-${Math.random().toString(36).slice(2, 12)}`

/** How long a finished turn's reply may take to reach this tab. */
const REPLY_SYNC_MS = 3000

/**
 * Works the threads assigned to the reader's AI assistant, one at a time:
 * takes the thread, opens the chat where there is a pane for it, asks the chat
 * to handle it as a turn in the conversation, and gives it back when the
 * answer has ended. A take another tab holds is refused, and this tab leaves
 * that thread alone while that take stands, a take's lifetime at most. A turn
 * that ends without the chat's reply (refused, failed, stopped) hands the
 * thread back to the reader, saying so in it.
 */
export function useChatCommentHandler(session: Ref<ChatThreadSession | null>, uid: Ref<number | null>) {
  const { chatOpen, openChatKeepingFocus, wide } = useSidePane()
  const { status } = useChatPanelSession()
  const ask = useChatAsk()
  /** Turns asked from this tab, by thread and latest message. */
  const asked = new Set<string>()
  /** Turns whose take was refused, and until when this tab leaves them alone. */
  const refused = new Map<string, number>()
  let working = false
  let lapseTimer: ReturnType<typeof setTimeout> | undefined

  /** Takes the next thread waiting on the chat, if it is free, and works it to the end of its turn. */
  async function next(): Promise<void> {
    const live = session.value
    // The threads arrive with the sync, before the session is live and a take can land.
    if (working || !live || live.liveStatus.value !== 'live' || status.value === 'submitted' || status.value === 'streaming') return
    const thread = nextForChat(live.threads.value, uid.value, Date.now(), skipped(live.threads.value))
    if (!thread) {
      lookAgainWhenATakeLapses(live)
      return
    }
    working = true
    try {
      const take = await live.takeForChat(thread.blockId, thread.threadId, TAB)
      if (!take) {
        // Another tab holds it. The server's take has lapsed one lifetime from
        // now, whatever this tab's clock says of its stamp.
        refused.set(turnKey(thread), Date.now() + CHAT_HANDLING_TTL_MS)
        return
      }
      // The reader follows the turn in the chat. Below `lg` the chat is a
      // modal slideover, so it stays shut there.
      if (!chatOpen.value && wide.value) openChatKeepingFocus()
      asked.add(turnKey(thread))
      const before = new Set(thread.messages.map(m => m.id))
      try {
        await ask(chatTurnText(thread), chatTurnContext(thread)).catch(() => {})
        await replied(live, thread, before)
        const now = find(live, thread)
        if (needsHandBack(now, uid.value, before, TAB)) live.handBackFromChat(thread.blockId, thread.threadId, HAND_BACK_TEXT)
      }
      finally {
        live.giveBackFromChat(thread.blockId, thread.threadId, take)
      }
    }
    finally {
      working = false
      void next()
    }
  }

  /**
   * The turns not to take now: asked already, or refused while the take that
   * refused them stands, a take's lifetime at most.
   */
  function skipped(threads: readonly CommentThread[]): Set<string> {
    const now = Date.now()
    for (const thread of threads) {
      if (!thread.handling) refused.delete(turnKey(thread))
    }
    for (const [key, until] of refused) {
      if (until <= now) refused.delete(key)
    }
    return new Set([...asked, ...refused.keys()])
  }

  /** Calls {@link next} again once the first live take on a waiting thread, or a refusal, has lapsed. */
  function lookAgainWhenATakeLapses(live: ChatThreadSession): void {
    clearTimeout(lapseTimer)
    const lapses = [...refused.values()]
    const lapse = firstLapseOfTakeOnThreadAwaitingChat(live.threads.value, uid.value, Date.now())
    if (lapse != null) lapses.push(lapse)
    if (lapses.length) lapseTimer = setTimeout(() => { void next() }, Math.min(...lapses) - Date.now())
  }

  /** The thread as the session holds it now. */
  function find(live: ChatThreadSession, thread: CommentThread): CommentThread | undefined {
    return live.threads.value.find(t => t.blockId === thread.blockId && t.threadId === thread.threadId)
  }

  /** Waits a moment for the chat's reply to sync to this tab. */
  function replied(live: ChatThreadSession, thread: CommentThread, before: ReadonlySet<string>): Promise<void> {
    const seen = () => {
      const now = find(live, thread)
      return !now || chatReplied(now, uid.value, before)
    }
    if (seen()) return Promise.resolve()
    return new Promise((resolve) => {
      const stop = watch(live.threads, () => {
        if (!seen()) return
        clearTimeout(timer)
        stop()
        resolve()
      })
      const timer = setTimeout(() => {
        stop()
        resolve()
      }, REPLY_SYNC_MS)
    })
  }

  watch([() => session.value?.threads.value, () => session.value?.liveStatus.value, status, uid], () => { void next() })
  onScopeDispose(() => clearTimeout(lapseTimer))
}
