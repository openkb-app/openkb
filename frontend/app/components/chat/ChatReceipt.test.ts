// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { createApp, h } from 'vue'
import ChatReceipt from './ChatReceipt.vue'
import type { Receipt } from '~/utils/chat-receipt'

/** The component in a bare Vue app, the Nuxt UI parts stubbed to what they show. */
function mount(receipt: Receipt, href: string | null) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp({ render: () => h(ChatReceipt, { receipt, href }) })
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

const CHANGED: Receipt = { changed: true, blocks: ['b-4a5e25ad'], removed: [], fields: [], created: false }
const HREF = '/demo-wiki/authoring-workflow?edit#b-4a5e25ad'

describe('ChatReceipt', () => {
  it('says what changed, names no page, and links the changed blocks to the change', () => {
    const root = mount(CHANGED, HREF)

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
    const root = mount({ ...CHANGED, removed: ['b-2'], fields: ['title'] }, HREF)

    expect(root.querySelector('p')?.textContent).toBe('1 block changed, 1 block removed, 1 field changed')
    expect([...root.querySelectorAll('a')].map(a => a.textContent)).toEqual(['1 block changed'])
  })

  it('links nothing when there is no change to go to', () => {
    const root = mount(CHANGED, null)

    expect(root.querySelector('p')?.textContent).toBe('1 block changed')
    expect(root.querySelector('a, button')).toBeNull()
  })

  it('says "Nothing changed" neutrally, with no link', () => {
    const root = mount({ ...CHANGED, changed: false, blocks: [] }, HREF)

    const receipt = root.querySelector('[data-test="answer-receipt"]')!
    expect(receipt.getAttribute('data-receipt-state')).toBe('unchanged')
    expect(receipt.getAttribute('data-color')).toBe('neutral')
    expect(receipt.querySelector('strong')?.textContent).toBe('Nothing changed')
    expect(receipt.textContent).toContain('The assistant wrote no change.')
    expect(root.querySelector('a, button')).toBeNull()
  })
})
