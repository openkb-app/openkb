// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { createApp, h } from 'vue'
import ChatSearchedFor from './ChatSearchedFor.vue'
import type { ToolSearch } from '~/utils/chat-answer'

/** The component in a bare Vue app, with the icon stubbed. */
function mount(searches: ToolSearch[]): HTMLElement {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp({ render: () => h(ChatSearchedFor, { searches }) })
  app.component('UIcon', { props: ['name'], render: () => h('span') })
  app.mount(root)
  return root
}

describe('ChatSearchedFor', () => {
  it('lists every search, the running one as searching', () => {
    const root = mount([
      { toolCallId: 'c-1', query: { terms: 'XK-4471B', question: 'Who maintains it?' }, running: false, hits: 1 },
      { toolCallId: 'c-2', query: { terms: '', question: 'pump maintenance' }, running: true },
    ])

    const rows = [...root.querySelectorAll('[data-test="chat-search"]')]
    expect(rows.map(row => row.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'XK-4471B · Who maintains it?, 1 hit',
      'pump maintenance, searching…',
    ])
    expect(rows[1]!.getAttribute('data-search-running')).toBe('true')
    // Searches added while the answer loads are announced.
    expect(root.querySelector('ul')!.getAttribute('aria-live')).toBe('polite')
  })

  it('renders nothing for a turn that searched nothing', () => {
    expect(mount([]).querySelector('[data-test="chat-searched-for"]')).toBeNull()
  })
})
