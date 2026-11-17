import { useMediaQuery } from '@vueuse/core'

export type SidePaneContent = 'outline' | 'chat' | 'comments' | 'summary'

/** A year: the pane is a working preference, not a session detail. */
const REMEMBER_FOR = 60 * 60 * 24 * 365

/** Whether the app has hydrated; the layout arms it. One flag, so everything
 *  the pane's arrival moves happens in a single render. */
export const sidePaneMounted = () => useState<boolean>('side-pane-mounted', () => false)

/** Which surface the right pane shows, and whether the reader has put it away.
 *
 * The page says through `request` what it wants there. An open chat sits on top
 * of that and stays open across pages until the reader closes it — except over
 * the review surface: editing shows Review and the chat as two sections of the
 * pane, each collapsible. `hidden` is remembered per browser, in a cookie.
 */
export function useSidePane() {
  const requested = useState<SidePaneContent | null>('side-pane', () => null)
  const chatOpen = useState<boolean>('side-pane-chat', () => false)
  /** The chat laid over the page's main column, until it returns to the side bar. */
  const chatEnlarged = useState<boolean>('side-pane-chat-enlarged', () => false)
  /** The Review section folded to its header, for this edit session. */
  const reviewCollapsed = useState<boolean>('side-pane-review-collapsed', () => false)
  // A question handed over from another surface, for the chat composer to pick
  // up and clear.
  const draft = useState<string>('side-pane-chat-draft', () => '')
  // Set by an open, read once by the composer: the pane remounts with every
  // page, and only the reader's own press means "type here".
  const chatFocus = useState<boolean>('side-pane-chat-focus', () => false)
  const store = useCookie<boolean>('okb-side-pane-hidden', {
    default: () => false,
    sameSite: 'lax',
    maxAge: REMEMBER_FOR,
  })
  const hidden = useState<boolean>('side-pane-hidden', () => store.value)
  const matchesWide = useMediaQuery('(min-width: 1024px)')
  const mounted = sidePaneMounted()

  const content = computed<SidePaneContent | null>(
    () => (chatOpen.value && requested.value !== 'comments' ? 'chat' : requested.value),
  )

  function request(next: SidePaneContent | null) {
    requested.value = next
  }

  function setHidden(next: boolean, focus?: string) {
    hidden.value = next
    store.value = next
    // The control the reader pressed is the one that goes away, so the caret
    // lands on the one that undoes it. Only when a press is what got us here:
    // a pane revealed by starting a comment must leave the caret in the text.
    if (focus && import.meta.client) {
      void nextTick(() => document.querySelector<HTMLElement>(focus)?.focus())
    }
  }

  /** Opens the chat and shows the pane for this visit, leaving the caret and the remembered choice as they are. */
  function openChatKeepingFocus() {
    chatOpen.value = true
    hidden.value = false
  }

  /** Opens the chat for the reader to type in, with `question` in the composer. */
  function openChat(question?: string) {
    if (question) draft.value = question
    chatFocus.value = true
    chatOpen.value = true
    setHidden(false)
  }

  function closeChat() {
    chatOpen.value = false
    chatEnlarged.value = false
  }

  return {
    content,
    hidden,
    chatOpen,
    chatEnlarged,
    reviewCollapsed,
    draft,
    /** The width at which there is a pane at all. False until the app has
     *  mounted: the viewport is not something the server can know, and the chat
     *  has two frames to choose between at that width. So the pane arrives once,
     *  after hydration, rather than differing between the two renders. */
    wide: computed(() => mounted.value && matchesWide.value),
    visible: computed(() => content.value !== null && !hidden.value),
    /** What the page wants the pane to show — `ChromePageBody`'s prop, which
     *  is the only thing that sets it. The pane lives inside the page, so a
     *  page that leaves takes its pane with it and nothing has to be given
     *  back; the arriving page's request is the next one. */
    request,
    openChat,
    openChatKeepingFocus,
    /** Whether the composer should take focus on this mount, asked once. */
    takeChatFocus() {
      const take = chatFocus.value
      chatFocus.value = false
      return take
    },
    closeChat,
    toggleChat(question?: string) {
      if (chatOpen.value && !hidden.value) closeChat()
      else openChat(question)
    },
    toggleChatEnlarged() {
      chatEnlarged.value = !chatEnlarged.value
    },
    hide: (options?: { focus?: boolean }) =>
      setHidden(true, options?.focus ? '[data-testid="side-pane-show"]' : undefined),
    show: (options?: { focus?: boolean }) =>
      setHidden(false, options?.focus ? '[data-testid="side-pane-hide"]' : undefined),
  }
}
