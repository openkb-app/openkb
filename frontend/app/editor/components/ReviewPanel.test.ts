// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { createApp, h } from 'vue'
import ReviewPanel from './ReviewPanel.vue'
import type { ReviewQueueRow } from '../review-marks'

/**
 * What the surface says when the gate holds — in a bare Vue app, with Nuxt UI
 * stubbed down to the elements this panel drives.
 *
 * The two holds are separate states and have to read as two: a queue a
 * sign-off clears, and id-less blocks no sign-off can.
 */
function mount(props: { queue?: ReviewQueueRow[], unidentified?: number }) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp({
    render: () => h(ReviewPanel as never, {
      queue: props.queue ?? [],
      threads: [],
      commentDraft: null,
      threadsShownFor: null,
      assigneeCandidates: [],
      me: null,
      unidentified: props.unidentified ?? 0,
    }),
  })
  app.component('UIcon', { props: ['name'], render: () => h('span') })
  app.component('UButton', {
    props: ['icon', 'color', 'variant', 'size', 'block'],
    setup: (_p, { slots }) => () => h('button', slots.default?.()),
  })
  app.component('EditorCommentThreads', { render: () => h('div') })
  app.mount(root)
  return root
}

const ROW: ReviewQueueRow = {
  id: 'b-1',
  kind: 'block',
  pos: 0,
  text: 'A changed paragraph',
  steps: ['peer'],
  state: 'reviewable',
  approvals: [{ step: 'peer', label: 'Mark reviewed', refusal: null }],
}

describe('ReviewPanel', () => {
  it('names the id-less blocks and the keystroke that fixes them', () => {
    const root = mount({ unidentified: 2 })
    const hold = root.querySelector('[data-testid="review-unidentified"]')
    expect(hold?.textContent).toContain('2 blocks have no id')
    expect(hold?.textContent).toContain('Editing such a block gives it one')
    // Not "nothing is waiting": something is, and it is on screen above this.
    expect(root.querySelector('[data-testid="review-queue-empty"]')).toBeNull()
  })

  it('says nothing is waiting only when neither hold stands', () => {
    const root = mount({})
    expect(root.querySelector('[data-testid="review-queue-empty"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="review-unidentified"]')).toBeNull()
  })

  it('lists both holds at once — one is not the other', () => {
    const root = mount({ queue: [ROW], unidentified: 1 })
    expect(root.querySelector('[data-testid="review-unidentified"]')?.textContent)
      .toContain('One block has no id')
    expect(root.querySelector('[data-testid="review-queue-summary"]')?.textContent)
      .toContain('One change is')
  })

  it('lists an unattributed row under its step, needing a sign-off', () => {
    const root = mount({ queue: [{ ...ROW, state: 'unattributed' }] })
    expect(root.querySelector('[data-testid="review-queue-empty"]')).toBeNull()
    expect(root.querySelector('#okb-review-step-peer')).not.toBeNull()
    expect(root.querySelector('[data-testid="review-queue-state-b-1"]')?.textContent)
      .toBe('Needs a sign-off — nobody on record wrote it')
  })

  it('offers the sign-off on a removed unattributed row', () => {
    const root = mount({ queue: [{ ...ROW, kind: 'removed', pos: null, text: '', state: 'unattributed' }] })
    expect(root.querySelector('[data-testid="review-queue-state-b-1"]')?.textContent)
      .toBe('Needs a sign-off — nobody on record wrote it')
    expect(root.querySelector('[data-testid="review-queue-approve-b-1"]')?.getAttribute('aria-disabled')).not.toBe('true')
  })
})
