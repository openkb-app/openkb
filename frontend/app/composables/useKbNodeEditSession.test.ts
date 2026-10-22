// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { computed, createApp, reactive, defineComponent, h, nextTick, onErrorCaptured, onScopeDispose, provide, ref, shallowRef, watch, watchEffect } from 'vue'
import type { KbCePageContext } from '~/composables/useKbCePage'
import type { EditorSession } from '~/components/PageInlineEditor.vue'
import { useKbNodeEditSession } from './useKbNodeEditSession'

vi.mock('@nuxt/ui/utils/editor', () => ({ createHandlers: () => ({}) }))
vi.mock('~/editor/menu-items', () => ({ comarkHandlers: {} }))
vi.mock('~/editor/review-marks', () => ({ addressableBlocks: () => [] }))

/**
 * The read → edit swap when the collab server does and does not answer.
 *
 * Nuxt's auto-imports are stubbed with Vue's own, and the composable runs
 * inside a mounted component so its scope is disposed as in the app.
 */

const route = reactive<{ path: string, query: Record<string, string> }>({ path: '/kb/page', query: {} })
const navigateTo = vi.fn()
/** The router's current route: the page's own until a refresh navigates away. */
let current: { path: string, query: Record<string, string> } = route

function stubNuxt() {
  route.query = { edit: '' }
  navigateTo.mockReset()
  current = route
  const vueGlobals = { computed, nextTick, onErrorCaptured, onScopeDispose, provide, ref, shallowRef, watch, watchEffect }
  for (const [name, fn] of Object.entries(vueGlobals)) vi.stubGlobal(name, fn)
  vi.stubGlobal('useRoute', () => route)
  vi.stubGlobal('useRouter', () => ({ currentRoute: { get value() { return current } } }))
  vi.stubGlobal('useToast', () => ({ add: () => {} }))
  vi.stubGlobal('useKbOutline', () => ({ trailFor: () => ({ space: null, nodes: [] }) }))
  vi.stubGlobal('navigateTo', navigateTo)
  vi.stubGlobal('onNuxtReady', () => {})
  vi.stubGlobal('refreshNuxtData', async () => {})
}

function mounted(refresh = async () => {}) {
  const env = { canEdit: ref(true), title: ref('Page'), refresh } as unknown as KbCePageContext
  let result!: ReturnType<typeof useKbNodeEditSession>
  const app = createApp(defineComponent({
    setup() {
      result = useKbNodeEditSession(env, { nid: ref(1), refreshModeration: async () => {} })
      return () => h('div')
    },
  }))
  app.mount(document.createElement('div'))
  return { session: result, unmount: () => app.unmount() }
}

/** An editor session as PageInlineEditor reports it up. */
function editorSession(synced: boolean) {
  return {
    synced: ref(synced),
    editorRef: ref({ editor: {} }),
    deletedRemotely: ref(false),
  } as unknown as EditorSession
}

describe('useKbNodeEditSession', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    stubNuxt()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('stays in preparing and reports the collab server unreachable after the timeout', async () => {
    const { session, unmount } = mounted()
    session.startEdit()
    await nextTick()
    session.setSession(editorSession(false))

    await vi.advanceTimersByTimeAsync(9_999)
    expect(session.collabUnreachable.value).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    expect(session.mode.value).toBe('preparing')
    expect(session.collabUnreachable.value).toBe(true)
    unmount()
  })

  it('swaps into edit once the late sync arrives', async () => {
    const { session, unmount } = mounted()
    session.startEdit()
    await nextTick()
    const s = editorSession(false)
    session.setSession(s)
    await vi.advanceTimersByTimeAsync(10_000)

    s.synced.value = true
    await vi.waitFor(() => expect(session.mode.value).toBe('edit'))
    await nextTick()

    expect(session.mode.value).toBe('edit')
    expect(session.collabUnreachable.value).toBe(false)
    unmount()
  })

  it('retry remounts the session and restarts the timeout', async () => {
    const { session, unmount } = mounted()
    session.startEdit()
    await nextTick()
    await vi.advanceTimersByTimeAsync(10_000)

    await session.retryEdit()
    await nextTick()

    expect(session.mode.value).toBe('preparing')
    expect(session.collabUnreachable.value).toBe(false)
    expect(session.session.value).toBeNull()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(session.collabUnreachable.value).toBe(true)
    unmount()
  })

  it('Back while unreachable returns to the read view and drops the edit session', async () => {
    const { session, unmount } = mounted()
    session.startEdit()
    await nextTick()
    session.setSession(editorSession(false))
    await vi.advanceTimersByTimeAsync(10_000)

    route.query = {}
    await nextTick()

    expect(session.mode.value).toBe('read')
    expect(session.session.value).toBeNull()
    expect(session.collabUnreachable.value).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    unmount()
  })

  it('cancel drops ?edit and returns to the read view', async () => {
    const { session, unmount } = mounted()
    session.startEdit()
    await nextTick()
    await vi.advanceTimersByTimeAsync(10_000)

    session.cancelEdit()
    await nextTick()

    expect(navigateTo).toHaveBeenCalledWith({ path: '/kb/page', query: {} }, { replace: true })
    expect(session.mode.value).toBe('read')
    unmount()
  })

  it('exiting drops ?edit from the page', async () => {
    const { session, unmount } = mounted()

    await session.exitToRead()

    expect(navigateTo).toHaveBeenCalledWith({ path: '/kb/page', query: {} }, { replace: true })
    unmount()
  })

  it('exiting stays where the refresh moved a renamed page', async () => {
    const { session, unmount } = mounted(async () => { current = { path: '/kb/renamed', query: {} } })

    await session.exitToRead()

    expect(navigateTo).not.toHaveBeenCalled()
    unmount()
  })

  it('leaves no timer behind when the page goes away while preparing', async () => {
    const { session, unmount } = mounted()
    session.startEdit()
    await nextTick()
    expect(vi.getTimerCount()).toBe(1)

    unmount()

    expect(vi.getTimerCount()).toBe(0)
  })
})
