// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { createApp, h } from 'vue'
import ChatReceipt from './ChatReceipt.vue'
import type { Receipt } from '~/utils/chat-receipt'

/** The component in a bare Vue app, the Nuxt UI parts stubbed to what they show. */
function mount(receipt: Receipt) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp({ render: () => h(ChatReceipt, { receipt }) })
  app.component('UAlert', {
    props: ['title', 'description', 'icon', 'color', 'variant'],
    setup: (props, { slots, attrs }) => () =>
      h('div', { ...attrs, 'data-color': props.color }, [h('strong', props.title), h('p', slots.description?.() ?? props.description), slots.actions?.()]),
  })
  app.component('ULink', {
    props: ['to'],
    setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()),
  })
  app.mount(root)
  return root
}

const CHANGED: Receipt = { changed: true, pages: [{ nid: 39, blocks: ['b-4a5e25ad'] }], removed: [], fields: [], created: false }
const HREF = '/node/39/edit#b-4a5e25ad'

describe('ChatReceipt', () => {
  it('says what changed, names no page, and links the changed blocks to the change', () => {
    const root = mount(CHANGED)

    const receipt = root.querySelector('[data-test="answer-receipt"]')!
    expect(receipt.getAttribute('data-receipt-state')).toBe('changed')
    expect(receipt.querySelector('strong')?.textContent).toBe('Changed')
    expect(receipt.querySelector('p')?.textContent).toBe('1 block changed')
    expect(receipt.textContent).not.toContain('authoring-workflow')
    expect(root.querySelector('a')?.getAttribute('href')).toBe(HREF)
    expect(root.querySelector('a')?.textContent).toBe('1 block changed')
    expect(root.querySelector('button')).toBeNull()
  })

  it('links only the changed blocks in a line that lists more', () => {
    const root = mount({ ...CHANGED, removed: ['b-2'], fields: ['title'] })

    expect(root.querySelector('p')?.textContent).toBe('1 block changed, 1 block removed, 1 field changed')
    expect([...root.querySelectorAll('a')].map(a => a.textContent)).toEqual(['1 block changed'])
  })

  it('links one count per page', () => {
    const root = mount({ ...CHANGED, pages: [...CHANGED.pages, { nid: 41, blocks: ['b-1', 'b-2'] }] })

    expect(root.querySelector('p')?.textContent).toBe('1 block changed, 2 blocks changed')
    expect([...root.querySelectorAll('a')].map(a => a.getAttribute('href'))).toEqual([HREF, '/node/41/edit#b-1'])
  })

  it('links nothing when there is no page to go to', () => {
    const root = mount({ ...CHANGED, pages: [{ nid: null, blocks: ['b-1'] }] })

    expect(root.querySelector('p')?.textContent).toBe('1 block changed')
    expect(root.querySelector('a, button')).toBeNull()
  })

  it('says "Nothing changed" neutrally, with no link', () => {
    const root = mount({ ...CHANGED, changed: false, pages: [] })

    const receipt = root.querySelector('[data-test="answer-receipt"]')!
    expect(receipt.getAttribute('data-receipt-state')).toBe('unchanged')
    expect(receipt.getAttribute('data-color')).toBe('neutral')
    expect(receipt.querySelector('strong')?.textContent).toBe('Nothing changed')
    expect(receipt.textContent).toContain('The assistant wrote no change.')
    expect(root.querySelector('a, button')).toBeNull()
  })
})
