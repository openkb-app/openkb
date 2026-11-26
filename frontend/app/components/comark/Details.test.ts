// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { setBrowserPrintRender } from '~/composables/usePrintRender'
import Details from './Details.vue'

/** The read page's section, server-rendered. */
function renderSection(props: Record<string, unknown>): Promise<string> {
  const app = createSSRApp({ render: () => h(Details, { summary: 'More', ...props }, { default: () => 'Inside.' }) })
  app.component('UIcon', { render: () => h('span') })
  return renderToString(app)
}

/** The read page's section, mounted in the browser. */
function mountSection(props: Record<string, unknown>): HTMLDetailsElement {
  const host = document.createElement('div')
  const app = createApp({ render: () => h(Details, { summary: 'More', ...props }, { default: () => 'Inside.' }) })
  app.component('UIcon', { render: () => h('span') })
  app.mount(host)
  return host.querySelector('details') as HTMLDetailsElement
}

afterEach(() => {
  setBrowserPrintRender(false)
})

describe('Details', () => {
  it('stays closed on screen', async () => {
    expect(await renderSection({})).toMatch(/^<details data-test="details"/)
  })

  it('is open in a print render', async () => {
    setBrowserPrintRender(true)
    expect(await renderSection({})).toMatch(/^<details open data-test="details"/)
  })

  it('keeps a section the reader opened open after a browser print', () => {
    const section = mountSection({})
    section.open = true
    setBrowserPrintRender(true)
    expect(section.open).toBe(true)
    setBrowserPrintRender(false)
    expect(section.open).toBe(true)
  })

  it('opens a closed section for a browser print and closes it after', () => {
    const section = mountSection({ open: true })
    section.open = false
    setBrowserPrintRender(true)
    expect(section.open).toBe(true)
    setBrowserPrintRender(false)
    expect(section.open).toBe(false)
  })
})
