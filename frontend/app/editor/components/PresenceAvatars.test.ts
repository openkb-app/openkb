// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { createApp, h } from 'vue'
import PresenceAvatars from './PresenceAvatars.vue'
import type { PresencePeer } from '#shared/utils/presence'

/**
 * The strip in a bare Vue app. Nuxt UI is stubbed down to what the component
 * drives, `UAvatarGroup` included: the stub mirrors its contract — keep `max`
 * children, prepend a `+N` avatar for the rest — so the cap the component picks
 * is asserted through the row it produces as well as through the prop.
 */
function mount(peers: PresencePeer[]): HTMLElement {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp({ render: () => h(PresenceAvatars as never, { peers }) })
  app.component('UAvatarGroup', {
    props: ['max', 'size', 'ui'],
    setup: (props, { slots }) => () => {
      const shown = (slots.default?.()[0]?.children ?? []) as unknown[]
      const hidden = shown.length - Math.min(shown.length, props.max as number)
      return h('div', { 'data-max': String(props.max) }, [
        hidden > 0 ? h('span', { 'data-stub': 'overflow' }, `+${hidden}`) : null,
        ...shown.slice(0, props.max as number),
      ])
    },
  })
  app.component('UTooltip', {
    props: ['text'],
    setup: (_props, { slots }) => () => slots.default?.(),
  })
  app.component('UAvatar', {
    props: ['text', 'size', 'ui'],
    setup: props => () => h('span', { 'data-stub': 'avatar' }, props.text),
  })
  app.component('UIcon', {
    props: ['name', 'size'],
    setup: props => () => h('span', { 'data-icon': props.name }),
  })
  app.mount(root)
  return root
}

function peer(clientId: number, name: string, via?: string): PresencePeer {
  return { clientId, name, uid: clientId, color: '#336699', isSelf: clientId === 1, ...(via ? { via } : {}) }
}

describe('PresenceAvatars', () => {
  it('caps the strip at five slots, the last one counting the rest', () => {
    const root = mount([1, 2, 3, 4, 5, 6].map(id => peer(id, `Peer ${id}`)))
    expect(root.querySelector('[data-max]')?.getAttribute('data-max')).toBe('4')
    expect(root.querySelectorAll('[data-presence-peer]')).toHaveLength(4)
    expect(root.querySelector('[data-stub="overflow"]')?.textContent?.trim()).toBe('+2')
  })

  it('shows every peer while they fit', () => {
    const root = mount([1, 2, 3].map(id => peer(id, `Peer ${id}`)))
    expect(root.querySelector('[data-max]')?.getAttribute('data-max')).toBe('5')
    expect(root.querySelectorAll('[data-presence-peer]')).toHaveLength(3)
    expect(root.querySelector('[data-stub="overflow"]')).toBeNull()
  })

  it('badges the agent peer with a robot, and nobody else', () => {
    const root = mount([peer(1, 'Ada'), peer(2, 'Ada', 'Claude')])
    const badges = root.querySelectorAll('[data-testid="agent-badge"]')
    expect(badges).toHaveLength(1)
    expect(badges[0]!.closest('[data-presence-peer]')?.getAttribute('aria-label')).toBe('Ada via Claude')
    expect(badges[0]!.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('sidekickicons:robot-20-solid')
  })

  it('names the viewer\'s own agent as theirs', () => {
    const root = mount([peer(1, 'Ada'), { ...peer(2, 'Ada', 'Claude'), uid: 1 }])
    const slots = root.querySelectorAll('[data-presence-peer]')
    expect(slots[1]!.getAttribute('aria-label')).toBe('Claude')
  })

  it('links a person to their profile', () => {
    const root = mount([peer(1, 'Ada'), peer(2, 'Ada', 'Claude')])
    const slots = root.querySelectorAll('[data-presence-peer]')
    expect(slots[0]!.tagName).toBe('A')
    expect(slots[0]!.getAttribute('href')).toBe('/user/1')
    // An agent is its owner's account but not that person sitting there.
    expect(slots[1]!.tagName).toBe('SPAN')
  })
})
