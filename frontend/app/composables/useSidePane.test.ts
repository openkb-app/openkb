import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, computed, nextTick } from 'vue'
import { useSidePane } from './useSidePane'

/**
 * The pane's state without a Nuxt app around it. `useState` and `useCookie` are
 * stubbed as shared-by-key refs, so every call in a test sees the same pane —
 * the way two components on a page do.
 */

let store: Map<string, ReturnType<typeof ref>>

beforeEach(() => {
  store = new Map()
  const shared = (key: string, init: () => unknown) => {
    if (!store.has(key)) store.set(key, ref(init()))
    return store.get(key)!
  }
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('nextTick', nextTick)
  vi.stubGlobal('useState', shared)
  vi.stubGlobal('useCookie', (key: string, opts: { default: () => unknown }) => shared(key, opts.default))
})

describe('the side pane', () => {
  it('shows what the page asked for, and nothing when no page has', () => {
    const pane = useSidePane()
    expect(pane.content.value).toBe(null)
    expect(pane.visible.value).toBe(false)

    pane.request('outline')
    expect(pane.content.value).toBe('outline')
    expect(pane.visible.value).toBe(true)
  })

  it('empties the pane for a page that wants none', () => {
    const pane = useSidePane()
    pane.request('outline')
    pane.request(null)
    expect(pane.content.value).toBe(null)
  })

  it('swaps what the page shows there', () => {
    const pane = useSidePane()
    pane.request('outline')
    pane.request('comments')
    expect(pane.content.value).toBe('comments')
  })

  it('keeps what is in the pane while the reader has it put away', () => {
    const pane = useSidePane()
    pane.request('outline')

    pane.hide()
    expect(pane.hidden.value).toBe(true)
    expect(pane.visible.value).toBe(false)
    // Hidden is the reader's doing, not the page's: the content stands.
    expect(pane.content.value).toBe('outline')

    pane.show()
    expect(pane.visible.value).toBe(true)
  })

  it('stays invisible while hidden, whatever a page asks for', () => {
    const pane = useSidePane()
    pane.hide()
    pane.request('outline')
    expect(pane.content.value).toBe('outline')
    expect(pane.visible.value).toBe(false)
  })

  it('remembers being put away, for the next surface that asks', () => {
    useSidePane().hide()
    // A second component reading the same state — the pane is one thing.
    expect(useSidePane().hidden.value).toBe(true)
  })

  /**
   * The chat is the reader's own doing, so it shows over what the page asked
   * for until they close it — and the page's request is still there when
   * they do.
   */
  it('shows the chat over whatever the page asked for, and gives it back on close', () => {
    const pane = useSidePane()
    pane.request('outline')

    pane.openChat()
    expect(pane.content.value).toBe('chat')

    pane.closeChat()
    expect(pane.content.value).toBe('outline')
  })

  it('keeps the chat while the page underneath it changes', () => {
    const pane = useSidePane()
    pane.request('outline')
    pane.openChat()

    // The next page asks for its own default; the chat is still what shows.
    pane.request('outline')
    expect(pane.content.value).toBe('chat')

    pane.closeChat()
    expect(pane.content.value).toBe('outline')
  })

  /**
   * Editing shows Review and the chat as two sections of one pane, so a chat
   * open when the editor opens stays open below Review.
   */
  it('keeps an open chat open beside the review surface', () => {
    const pane = useSidePane()
    pane.request('outline')
    pane.openChat()

    pane.request('comments')
    expect(pane.content.value).toBe('comments')
    expect(pane.chatOpen.value).toBe(true)

    pane.request('outline')
    expect(pane.content.value).toBe('chat')
  })

  /**
   * A search's summary is the page's own surface, so an open chat covers it,
   * and closing the chat shows it again.
   */
  it('keeps an open chat over the summary a search asks for', () => {
    const pane = useSidePane()
    pane.request('outline')
    pane.openChat()

    pane.request('summary')
    expect(pane.content.value).toBe('chat')

    pane.closeChat()
    expect(pane.content.value).toBe('summary')

    // Leaving the search takes its summary with it.
    pane.request('outline')
    expect(pane.content.value).toBe('outline')
  })

  it('toggles the chat section open and shut while editing', () => {
    const pane = useSidePane()
    pane.request('comments')

    pane.toggleChat()
    expect(pane.chatOpen.value).toBe(true)
    pane.toggleChat()
    expect(pane.chatOpen.value).toBe(false)
  })

  it('enlarges the chat until minimized, and closing it minimizes it too', () => {
    const pane = useSidePane()
    pane.openChat()

    pane.toggleChatEnlarged()
    expect(pane.chatEnlarged.value).toBe(true)
    pane.toggleChatEnlarged()
    expect(pane.chatEnlarged.value).toBe(false)

    pane.toggleChatEnlarged()
    pane.closeChat()
    expect(pane.chatEnlarged.value).toBe(false)
  })

  it('toggles the chat shut, and brings a put-away pane back with it', () => {
    const pane = useSidePane()
    pane.request('outline')

    pane.toggleChat()
    expect(pane.content.value).toBe('chat')
    pane.toggleChat()
    expect(pane.content.value).toBe('outline')

    // Hidden, then asked for: the reader means to see it.
    pane.hide()
    pane.toggleChat()
    expect(pane.hidden.value).toBe(false)
    expect(pane.content.value).toBe('chat')
  })

  it('carries a question handed over by another surface', () => {
    const pane = useSidePane()
    pane.openChat('why is the sky blue')
    expect(pane.draft.value).toBe('why is the sky blue')
  })

  /**
   * The composer asks on every mount, and the pane remounts with the page. Only
   * the mount that follows the reader's own open is told to take the caret.
   */
  it('hands the caret to the chat once per open, not once per page', () => {
    const pane = useSidePane()
    expect(pane.takeChatFocus()).toBe(false)

    pane.openChat()
    expect(pane.takeChatFocus()).toBe(true)
    expect(pane.takeChatFocus()).toBe(false)
  })
})
