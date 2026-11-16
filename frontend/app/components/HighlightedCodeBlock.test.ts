// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'
import { renderToString } from 'vue/server-renderer'
import HighlightedCodeBlock from './HighlightedCodeBlock.vue'
import source from './HighlightedCodeBlock.vue?raw'
import type { CodeLine } from '#shared/utils/code-highlight'

const UIcon = defineComponent({ props: { name: String }, setup: props => () => h('span', { 'data-icon': props.name }) })

const LINES: CodeLine[] = [
  [{ content: 'const', style: '--shiki-light:#cf222e;--shiki-dark:#ff7b72' }, { content: ' a = ' }, { content: '"<b>"', style: '--shiki-light:#0a3069;--shiki-dark:#a5d6ff' }],
  [],
  [{ content: 'a' }],
]

function mount(props: Record<string, unknown>): HTMLElement {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp({ render: () => h(HighlightedCodeBlock, props) })
  app.component('UIcon', UIcon)
  app.mount(root)
  return root
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('HighlightedCodeBlock', () => {
  it('renders the tokens as spans carrying the theme variables, the text escaped', () => {
    const root = mount({ id: 'b-1a2b', language: 'typescript', lines: LINES })
    const pre = root.querySelector('pre')!
    expect(pre.id).toBe('b-1a2b')
    const tokens = [...pre.querySelectorAll('code .okb-code-token')]
    expect(tokens.map(t => t.textContent)).toEqual(['const', '"<b>"'])
    expect((tokens[0] as HTMLElement).style.getPropertyValue('--shiki-dark')).toBe('#ff7b72')
    expect(pre.querySelector('code b')).toBeNull()
    expect(pre.querySelector('code')!.textContent).toBe('const a = "<b>"\n\na')
  })

  it('labels the language, and shows none for a plain fence', () => {
    expect(mount({ language: 'typescript', lines: LINES }).querySelector('.okb-code-lang')?.textContent).toBe('TypeScript')
    expect(mount({ lines: LINES }).querySelector('.okb-code-lang')).toBeNull()
  })

  it('copies the code from a labelled button and confirms it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const root = mount({ language: 'typescript', lines: LINES })
    const button = root.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')!
    expect(button.type).toBe('button')
    button.click()
    await vi.waitFor(() => expect(root.querySelector('[role="status"]')!.textContent).toBe('Code copied'))
    expect(writeText).toHaveBeenCalledWith('const a = "<b>"\n\na')
    expect(button.dataset.state).toBe('copied')
  })

  it('says so when the clipboard is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    const root = mount({ lines: LINES })
    root.querySelector('button')!.click()
    await nextTick()
    await vi.waitFor(() => expect(root.querySelector('[role="status"]')!.textContent).toMatch(/Copy failed/))
  })

  it('server-renders the code with no whitespace of its own', async () => {
    const app = createApp({ render: () => h(HighlightedCodeBlock, { lines: [[{ content: 'x' }], [{ content: 'y' }]] }) })
    app.component('UIcon', UIcon)
    const html = (await renderToString(app)).replace(/<!--.*?-->/g, '')
    expect(html).toMatch(/<code><span>x<\/span>\n<span>y<\/span><\/code><\/pre>$/)
    expect(html).toMatch(/^<pre class="okb-code"><span class="okb-code-tools">/)
  })

  it('never renders markup from the tree', () => {
    expect(source).toContain('<template>')
    expect(source).not.toContain('v-html')
  })
})
