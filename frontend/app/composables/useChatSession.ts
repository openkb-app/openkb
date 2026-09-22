// Explicit imports, not Nuxt auto-imports: the composable is exercised by its
// own vitest suite outside a Nuxt app.
import { computed, ref, type Ref } from 'vue'
import { Chat } from '@ai-sdk/vue'
import { DefaultChatTransport } from 'ai'
import type { UIMessage } from 'ai'
import { SCOPE_ALL } from '#shared/utils/chat-scope'

/** What the reader is told when the chat endpoint itself did not answer. */
export const TRANSPORT_ERROR = 'The chat service could not be reached. Try again in a moment.'

/** The same, for the one status a reader can act on. */
export const AUTH_ERROR = 'Log in to ask OpenKnowledgebase.'

/**
 * One conversation's worth of state. Every caller that wants a thread of its
 * own — the search page's AI summary — calls this; the chat panel asks for
 * the shared one below.
 *
 * All of them talk to the same endpoint and owe the reader the same three
 * outcomes: an answer, a log-in prompt, or a sentence saying why there is no
 * answer.
 */
export function useChatSession() {
  /** The status of the last response that was not OK. */
  const httpStatus = ref<number | null>(null)

  const chat = new Chat<UIMessage>({
    transport: new DefaultChatTransport({
      api: '/api/chat',
      fetch: async (input, init) => {
        httpStatus.value = null
        let response: Response
        try {
          response = await globalThis.fetch(input, init)
        }
        catch (err) {
          // The composer's stop button aborts the request: the reader's own
          // doing, so the abort reaches the SDK as itself.
          if (init?.signal?.aborted) throw err
          throw new Error(TRANSPORT_ERROR)
        }
        if (response.ok) return response
        httpStatus.value = response.status
        // The SDK throws with the response body — a JSON blob or an HTML error
        // page, neither of which is a sentence to show a reader.
        throw new Error(response.status === 401 ? AUTH_ERROR : TRANSPORT_ERROR)
      },
    }),
  })

  return {
    chat,
    // Reactive proxies — Vue tracks via the VueChatState ref.
    messages: computed(() => chat.messages),
    status: computed(() => chat.status),
    /**
     * The proxy refused the turn, so the reader has somewhere to go. Read off
     * the failed turn, so logging in elsewhere and asking again clears it.
     */
    needsAuth: computed(() => httpStatus.value === 401 && chat.status === 'error'),
    /**
     * Why the last turn was not answered, in one sentence. The stream's
     * `error` part arrives here, not as a message part.
     */
    error: computed(() => chat.error?.message ?? null),
    /**
     * Drops the thread, stopping the turn in flight first: a running stream
     * keeps writing into `messages`. `error` is get-only; the SDK clears it
     * with the status.
     */
    clear: () => {
      void chat.stop()
      chat.messages = []
      chat.clearError()
    },
  }
}

type ChatSession = ReturnType<typeof useChatSession>

/**
 * The reader's place in the panel that is not in the thread: what they have
 * typed and not sent, how far down they have read, and what they scoped the
 * retrieval to.
 */
type PanelSession = ChatSession & {
  unsent: Ref<string>
  scrollTop: Ref<number>
  scope: Ref<string>
}

let panelSession: PanelSession | null = null

const newPanelSession = (): PanelSession => ({
  ...useChatSession(),
  unsent: ref(''),
  scrollTop: ref(0),
  scope: ref(SCOPE_ALL),
})

/**
 * The chat panel's conversation: one per app, so everything that unmounts the
 * panel leaves it standing — crossing `lg`, the pane going to review, and every
 * navigation. Module scope is per-app in the browser; a server render gets a
 * throwaway of its own.
 */
export function useChatPanelSession(): PanelSession {
  if (import.meta.server) return newPanelSession()
  return (panelSession ??= newPanelSession())
}
