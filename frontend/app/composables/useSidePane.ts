import { useMediaQuery } from '@vueuse/core'

export type SidePaneContent = 'outline' | 'chat' | 'comments' | 'summary'

/** A year: the pane is a working preference, not a session detail. */
const REMEMBER_FOR = 60 * 60 * 24 * 365

/** Whether the app has hydrated; the layout arms it. One flag, so everything
 *  the pane's arrival moves happens in a single render. */
export const sidePaneMounted = () => useState<boolean>('side-pane-mounted', () => false)

/** The surfaces a page owes its reader beside the body: an open chat waits
 *  behind these instead of covering them. Editing owes the editor the review
 *  surface beside the text. */
const PARKS_CHAT = new Set<SidePaneContent>(['comments'])

/** Which surface the right pane shows, and whether the reader has put it away.
 *
 * The page says through `request` what it wants there. An open chat sits on top
 * of that, except over the surfaces in `PARKS_CHAT`, and stays open across
 * pages until the reader closes it. `hidden` is remembered per browser, in a
 * cookie.
 */
export function useSidePane() {
  const requested = useState<SidePaneContent | null>('side-pane', () => null)
  const chatOpen = useState<boolean>('side-pane-chat', () => false)
  const chatParked = useState<boolean>('side-pane-chat-parked', () => false)
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

  // Parked, not closed: the conversation and the open flag stand, so the chat
  // is back the moment the page stops asking for a surface of its own. Opening
  // it again from there unparks it.
  const parked = computed(() =>
    chatParked.value && !!requested.value && PARKS_CHAT.has(requested.value),
  )
  const content = computed<SidePaneContent | null>(
    () => (chatOpen.value && !parked.value ? 'chat' : requested.value),
  )

  function request(next: SidePaneContent | null) {
    requested.value = next
    if (next && PARKS_CHAT.has(next)) chatParked.value = true
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

  function openChat(question?: string) {
    if (question) draft.value = question
    chatOpen.value = true
    chatParked.value = false
    chatFocus.value = true
    setHidden(false)
  }

  return {
    content,
    hidden,
    chatOpen,
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
    /** Whether the composer should take focus on this mount, asked once. */
    takeChatFocus() {
      const take = chatFocus.value
      chatFocus.value = false
      return take
    },
    closeChat() {
      chatOpen.value = false
    },
    /** Give the pane back to what the page asked for, without ending the chat. */
    parkChat() {
      chatParked.value = true
    },
    toggleChat(question?: string) {
      if (content.value === 'chat' && !hidden.value) chatOpen.value = false
      else openChat(question)
    },
    hide: (options?: { focus?: boolean }) =>
      setHidden(true, options?.focus ? '[data-testid="side-pane-show"]' : undefined),
    show: (options?: { focus?: boolean }) =>
      setHidden(false, options?.focus ? '[data-testid="side-pane-hide"]' : undefined),
  }
}
