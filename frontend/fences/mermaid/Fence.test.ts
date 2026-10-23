// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import Fence from './Fence.vue'

const mounts: Array<{ el: HTMLElement, source: string, options: Record<string, any> }> = []
const updates: string[] = []

vi.mock('pele/lazy', () => ({
  detectType: () => 'flowchart',
  load: () => Promise.resolve(true),
  mount: (el: HTMLElement, source: string, options: Record<string, any>) => {
    mounts.push({ el, source, options })
    el.innerHTML = '<svg data-client></svg>'
    return { update: (next: string) => updates.push(next), destroy: () => {} }
  },
}))

const SOURCE = 'flowchart LR\n  A --> B'
const SVG = '<svg class="pele" data-server><text>A</text></svg>'

const apps: Array<ReturnType<typeof createApp>> = []

function mount(props: Record<string, unknown>): { root: HTMLElement, vm: Record<string, unknown> } {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp({ data: () => props, render() { return h(Fence, { ...this.$data }) } })
  apps.push(app)
  return { root, vm: app.mount(root) as unknown as Record<string, unknown> }
}

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount()
  document.body.innerHTML = ''
  mounts.length = 0
  updates.length = 0
})

describe('the mermaid Fence', () => {
  it('shows the server SVG, then hands the element to pele with http and https links only', async () => {
    const { root } = mount({ source: SOURCE, html: SVG })
    expect(root.querySelector('.okb-diagram-canvas > svg[data-server]')).not.toBeNull()
    await vi.waitFor(() => expect(mounts).toHaveLength(1))
    expect(mounts[0]!.source).toBe(SOURCE)
    expect(mounts[0]!.el.classList.contains('okb-diagram-canvas')).toBe(true)
    expect(mounts[0]!.options).toMatchObject({ linkSchemes: ['http', 'https'], imageSchemes: ['http', 'https'] })
  })

  it('updates the mounted diagram on a source change', async () => {
    const { vm } = mount({ source: SOURCE, preview: true })
    await vi.waitFor(() => expect(mounts).toHaveLength(1))
    vm.source = 'flowchart LR\n  A --> C'
    await vi.waitFor(() => expect(updates).toEqual(['flowchart LR\n  A --> C']))
  })

  it("emits pele's error with its place, and null on the next render", async () => {
    const errors: unknown[] = []
    mount({ source: SOURCE, preview: true, onError: (e: unknown) => errors.push(e) })
    await vi.waitFor(() => expect(mounts).toHaveLength(1))
    mounts[0]!.options.onError(Object.assign(new Error('Parse error'), { line: 3, column: 8 }))
    mounts[0]!.options.onRender({})
    await nextTick()
    expect(errors).toEqual([{ message: 'Parse error', line: 3, column: 8 }, null])
  })
})
