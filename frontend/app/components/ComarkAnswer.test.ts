// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Suspense, computed, createApp, h, nextTick, ref, shallowRef, watch } from 'vue'
import ComarkAnswer from './ComarkAnswer.vue'

// Native tags only: the answers here mount no comark component.
vi.mock('~/comark/components', async () => {
  const { HTML_ELEMENTS } = await import('#shared/utils/comark-tree')
  return { comarkComponents: Object.fromEntries([...HTML_ELEMENTS].map(tag => [tag, tag])) }
})

beforeEach(() => {
  // Nuxt auto-imports the component uses.
  vi.stubGlobal('shallowRef', shallowRef)
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('watch', watch)
  vi.stubGlobal('useAllowedHtml', () => computed(() => undefined))
  vi.stubGlobal('$fetch', vi.fn())
})

/** Mounts an answer; the returned props drive it like the chat panel does. */
function mount(text: string, streaming: boolean) {
  const props = ref({ text, streaming })
  const root = document.createElement('div')
  // `MarkdownDocument` sets up async; Nuxt's app root is the Suspense for it.
  createApp({ render: () => h(Suspense, null, () => h(ComarkAnswer, props.value)) }).mount(root)
  return { root, props }
}

/** Waits for the async parse to render `text`. */
async function rendered(root: HTMLElement, text: string) {
  await vi.waitFor(() => expect(root.textContent).toContain(text))
  await nextTick()
  return root.textContent
}

describe('ComarkAnswer', () => {
  const NESTED = 'Some **b***i* text.'

  it('renders a finished answer without the streaming repair', async () => {
    const { root } = mount(NESTED, false)
    expect(await rendered(root, 'text.')).not.toContain('****')
  })

  it('re-parses without the repair once the stream is done', async () => {
    const { root, props } = mount(NESTED, true)
    await rendered(root, 'text.')
    props.value = { text: `${NESTED} Done.`, streaming: false }
    expect(await rendered(root, 'Done.')).not.toContain('****')
  })

  it('re-parses when only the streaming flag flips', async () => {
    // The last chunk arrives before the status flips.
    const { root, props } = mount(NESTED, true)
    await rendered(root, '****')
    props.value = { text: NESTED, streaming: false }
    await vi.waitFor(() => expect(root.textContent).not.toContain('****'))
    expect(root.textContent).toContain('text.')
  })
})
