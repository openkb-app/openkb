// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createSSRApp, createApp, defineComponent, h, nextTick } from 'vue'
import { renderToString } from 'vue/server-renderer'
import CustomFence from './CustomFence.vue'
import CustomCodeBlock from './CustomCodeBlock.vue'

const UIcon = defineComponent({ props: { name: String }, setup: props => () => h('span', { 'data-icon': props.name }) })

const SOURCE = 'one\n  two'
const SVG = '<svg data-server><text>one</text></svg>'

const apps: Array<ReturnType<typeof createApp>> = []

function withStubs<T extends ReturnType<typeof createApp>>(app: T): T {
  apps.push(app)
  app.component('UIcon', UIcon)
  app.component('CustomCodeBlock', CustomCodeBlock)
  return app
}

/** Mounts the frame around the `stub` fence (test/stubs/fences/stub), its props reactive on the returned `vm`. */
function mount(props: Record<string, unknown>): { root: HTMLElement, vm: Record<string, unknown> } {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const vm = withStubs(createApp({
    data: () => ({ fence: 'stub', ...props }),
    render() {
      return h(CustomFence, { ...this.$data })
    },
  })).mount(root) as unknown as Record<string, unknown>
  return { root, vm }
}

const errorText = (root: HTMLElement) => root.querySelector('.okb-fence-error')!.textContent!.trim()

afterEach(() => {
  for (const app of apps.splice(0)) {
    if (app._container) app.unmount()
  }
  document.body.innerHTML = ''
})

describe('CustomFence', () => {
  it('server-renders the HTML it is handed, with the block id on the figure', async () => {
    const html = await renderToString(withStubs(createSSRApp({ render: () => h(CustomFence, { id: 'b-d1', fence: 'stub', source: SOURCE, html: SVG }) })))
    expect(html).toMatch(/^<figure class="okb-fence" data-fence="stub" data-state="ok" id="b-d1">/)
    expect(html).toContain(SVG)
    expect(html).toMatch(/<button type="button" class="okb-fence-toggle" aria-expanded="false"/)
  })

  it("hands the source to the fence's component", async () => {
    const { root } = mount({ source: SOURCE, html: SVG })
    await vi.waitFor(() => expect(root.querySelector('.stub-canvas')).not.toBeNull())
    expect(root.querySelector('.stub-canvas > svg[data-server]')!.textContent).toBe('one')
  })

  it('toggles the source from a labelled button', async () => {
    const { root } = mount({ source: SOURCE, html: SVG })
    const button = root.querySelector<HTMLButtonElement>('button.okb-fence-toggle')!
    const panel = document.getElementById(button.getAttribute('aria-controls')!)!
    expect(panel.style.display).toBe('none')
    button.click()
    await nextTick()
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.textContent).toContain('Hide source')
    expect(panel.style.display).toBe('')
    expect(panel.querySelector('code')!.textContent).toBe(SOURCE)
  })

  it('shows a server-side error as text with its place and the source, and draws nothing', async () => {
    const { root } = mount({ source: 'x', error: { message: '<b>bad</b>', line: 2, column: 5 } })
    const region = root.querySelector('.okb-fence-error')!
    expect(region.getAttribute('role')).toBe('status')
    expect(region.hasAttribute('aria-live')).toBe(false)
    expect(errorText(root)).toBe('This sketch could not be drawn. Line 2, column 5: <b>bad</b>')
    expect(region.querySelector('b')).toBeNull()
    expect(root.querySelector('button.okb-fence-toggle')!.getAttribute('aria-expanded')).toBe('true')
    await nextTick()
    expect(root.querySelector('.stub-canvas')).toBeNull()
  })

  it("reports the component's error and clears it on the next draw", async () => {
    const errors: unknown[] = []
    const { root, vm } = mount({ source: 'o!ne', preview: true, onError: (e: unknown) => errors.push(e) })
    await vi.waitFor(() => expect(errorText(root)).toBe('This sketch could not be drawn. Line 1, column 2: Unexpected "!"'))
    vm.source = 'one'
    await vi.waitFor(() => expect(errorText(root)).toBe(''))
    expect(errors).toEqual([{ message: 'Unexpected "!"', line: 1, column: 2 }, null])
  })

  it('shows a streaming fence as code, and draws it once it closes', async () => {
    const { root, vm } = mount({ source: SOURCE, pending: true })
    expect(root.querySelector('pre code')!.textContent).toBe(SOURCE)
    expect(root.querySelector('.stub-canvas')).toBeNull()
    vm.pending = false
    await vi.waitFor(() => expect(root.querySelector('.stub-canvas')).not.toBeNull())
  })

  it('is the same frame in the editor: the toggle, and the source it is handed', async () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    withStubs(createApp({
      render: () => h(CustomFence, { fence: 'stub', source: SOURCE, preview: true, wrapper: 'section' }, {
        source: () => h('pre', { class: 'editable' }, SOURCE),
      }),
    })).mount(root)
    await vi.waitFor(() => expect(root.querySelector('.stub-canvas')).not.toBeNull())
    expect(root.firstElementChild!.matches('section.okb-fence')).toBe(true)
    const button = root.querySelector<HTMLButtonElement>('button.okb-fence-toggle')!
    expect(button.textContent).toContain('Show source')
    button.click()
    await nextTick()
    expect(document.getElementById(button.getAttribute('aria-controls')!)!.querySelector('pre.editable')!.textContent).toBe(SOURCE)
    expect(root.querySelector('.okb-code')).toBeNull()
  })

  it('opens the source on an error the component reports', async () => {
    const { root } = mount({ source: 'o!ne', preview: true })
    const button = root.querySelector<HTMLButtonElement>('button.okb-fence-toggle')!
    await vi.waitFor(() => expect(button.getAttribute('aria-expanded')).toBe('true'))
  })

  it("opens on the first draw's error only: a later one leaves the toggle alone", async () => {
    const { root, vm } = mount({ source: 'one', preview: true })
    await vi.waitFor(() => expect(root.querySelector('.stub-canvas')).not.toBeNull())
    vm.source = 'o!ne'
    await vi.waitFor(() => expect(errorText(root)).not.toBe(''))
    expect(root.querySelector('button.okb-fence-toggle')!.getAttribute('aria-expanded')).toBe('false')
  })

  it("draws in the editor from the server's error, open and naming it from the first render", () => {
    const { root } = mount({ source: 'o!ne', preview: true, error: { message: 'Unexpected "!"', line: 1, column: 2 } })
    expect(root.querySelector('button.okb-fence-toggle')!.getAttribute('aria-expanded')).toBe('true')
    expect(errorText(root)).toBe('This sketch could not be drawn. Line 1, column 2: Unexpected "!"')
    expect(root.querySelector('.stub-canvas')).not.toBeNull()
  })

  it('emits the toggle', async () => {
    const toggles: boolean[] = []
    const { root } = mount({ source: 'one', onToggle: (open: boolean) => toggles.push(open) })
    root.querySelector<HTMLButtonElement>('button.okb-fence-toggle')!.click()
    root.querySelector<HTMLButtonElement>('button.okb-fence-toggle')!.click()
    expect(toggles).toEqual([true, false])
  })

  it('asks for a source in an empty preview, and draws nothing', async () => {
    const { root } = mount({ source: '  ', preview: true })
    expect(root.querySelector('.okb-fence-hint')!.textContent!.trim()).toBe('Write Stub in the source to see the sketch.')
    await nextTick()
    expect(root.querySelector('.stub-canvas')).toBeNull()
  })
})
