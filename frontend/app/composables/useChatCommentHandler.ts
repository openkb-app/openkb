import type { Ref } from 'vue'
import type { CommentThread } from '#shared/block-comments'
import { chatReplied, chatTurnContext, chatTurnText, HAND_BACK_TEXT, needsHandBack, nextForChat, turnKey } from '~/editor/chat-comments'

/** What the handler needs of the edit session. */
interface ChatThreadSession {
  threads: Ref<CommentThread[]>
  takeForChat: (blockId: string, threadId: string, tab: string) => Promise<string | null>
  giveBackFromChat: (blockId: string, threadId: string, msgId: string) => void
  handBackFromChat: (blockId: string, threadId: string, text: string) => void
}

/** This tab's id: what its takes name, so tabs of one account tell them apart. */
const TAB = `t-${Math.random().toString(36).slice(2, 12)}`

/** How long a finished turn's reply may take to reach this tab. */
const REPLY_SYNC_MS = 3000

/**
 * Works the threads assigned to the reader's AI chat, one at a time, while the
 * chat is open: takes the thread, asks the chat to handle it as a turn in the
 * conversation, and gives it back when the answer has ended. A take another
 * tab holds is refused, and that thread is left to it. A turn that ends
 * without the chat's reply (refused, failed, stopped) hands the thread back to
 * the reader, saying so in it.
 */
export function useChatCommentHandler(session: Ref<ChatThreadSession | null>, uid: Ref<number | null>) {
  const { chatOpen } = useSidePane()
  const { status } = useChatPanelSession()
  const ask = useChatAsk()
  /** Turns asked from this tab, by thread and latest message. */
  const asked = new Set<string>()
  let working = false

  /** Takes the next thread waiting on the chat, if it is free, and works it to the end of its turn. */
  async function next(): Promise<void> {
    const live = session.value
    if (working || !live || !chatOpen.value || status.value === 'submitted' || status.value === 'streaming') return
    const thread = nextForChat(live.threads.value, uid.value, Date.now(), asked)
    if (!thread) return
    working = true
    asked.add(turnKey(thread))
    try {
      const take = await live.takeForChat(thread.blockId, thread.threadId, TAB)
      if (!take) return
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

  watch([() => session.value?.threads.value, chatOpen, status, uid], () => { void next() })
}
