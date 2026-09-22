// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { createApp, createSSRApp, h, nextTick, ref } from 'vue'
import { renderToString } from 'vue/server-renderer'
// The real directive, by path: the package exports only its module entry, and
// Nuxt registers this file's directive through a plugin at build time.
import { vDrupalMarkup } from '../../../node_modules/nuxtjs-drupal-ce/dist/runtime/directives/drupalMarkup'
import DrupalMarkup from './DrupalMarkup.vue'

const FORM_HTML = '<label for="label">Label</label><input id="label" name="label" required>'

/** The app as Nuxt builds it: the module registers the directive app-wide. */
function app(content: string, ssr: boolean) {
  const create = ssr ? createSSRApp : createApp
  const instance = create(DrupalMarkup, { content })
  instance.directive('drupal-markup', vDrupalMarkup)
  return instance
}

/**
 * Server-renders the component and hydrates the result, with a chance to touch
 * the server-rendered DOM in between — the window a visitor types in.
 */
async function ssrThenHydrate(content: string, beforeHydration: (root: HTMLElement) => void) {
  const root = document.createElement('div')
  root.innerHTML = await renderToString(app(content, true))
  const served = root.innerHTML
  beforeHydration(root)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  app(content, true).mount(root)
  await nextTick()
  const warnings = warn.mock.calls.map(args => String(args[0]))
  warn.mockRestore()
  return { root, served, warnings }
}

describe('DrupalMarkup', () => {
  it('renders the markup unchanged through hydration', async () => {
    const { root, served, warnings } = await ssrThenHydrate(FORM_HTML, () => {})
    expect(served).toContain('<input id="label"')
    expect(root.innerHTML).toBe(served)
    expect(warnings).toEqual([])
  })

  it('keeps what the visitor typed before hydration', async () => {
    const { root } = await ssrThenHydrate(FORM_HTML, (el) => {
      el.querySelector('input')!.value = 'My first client'
    })
    expect(root.querySelector('input')!.value).toBe('My first client')
  })

  it('adopts the server-rendered nodes instead of re-creating them', async () => {
    let served: HTMLInputElement | undefined
    const { root } = await ssrThenHydrate(FORM_HTML, (el) => {
      served = el.querySelector('input')!
    })
    expect(root.querySelector('input')).toBe(served)
  })

  it('renders on a client-side mount', () => {
    const root = document.createElement('div')
    app('<p>one</p>', false).mount(root)
    expect(root.innerHTML).toContain('<p>one</p>')
  })

  it('replaces the markup when the content changes', async () => {
    const content = ref('<p>one</p>')
    const instance = createApp({ render: () => h(DrupalMarkup, { content: content.value }) })
    instance.directive('drupal-markup', vDrupalMarkup)
    const root = document.createElement('div')
    instance.mount(root)
    content.value = '<p>two</p>'
    await nextTick()
    expect(root.innerHTML).toContain('<p>two</p>')
    expect(root.innerHTML).not.toContain('<p>one</p>')
  })
})
