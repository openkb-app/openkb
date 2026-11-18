// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import ReviewPanel from './ReviewPanel.vue'
import type { ReviewQueueRow, UnidentifiedRow } from '../review-marks'

/**
 * What the surface says when the gate holds — in a bare Vue app, with Nuxt UI
 * stubbed down to the elements this panel drives.
 *
 * The two holds are separate states and have to read as two: a queue a
 * sign-off clears, and id-less blocks no sign-off can.
 */
function mount(props: {
  queue?: ReviewQueueRow[]
  unidentified?: UnidentifiedRow[]
  signedOff?: boolean
  refused?: string[]
  onApproveAll?: (e: unknown) => void
  onJump?: (row: { pos: number | null }) => void
}) {
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
      unidentified: props.unidentified ?? [],
      signedOff: props.signedOff ?? false,
      refused: props.refused ?? [],
      onApproveAll: props.onApproveAll,
      onJump: props.onJump,
    }),
  })
  app.component('UIcon', { props: ['name'], render: () => h('span') })
  app.component('UButton', {
    props: ['icon', 'color', 'variant', 'size', 'block'],
    setup: (_p, { slots }) => () => h('button', slots.default?.()),
  })
  app.component('UModal', {
    props: ['open', 'title', 'close', 'content'],
    setup: (p, { slots }) => () => p.open
      ? h('div', { 'data-testid': 'modal', ...p.content }, [h('h2', p.title), slots.body?.(), slots.footer?.()])
      : null,
  })
  app.component('UAlert', {
    props: ['color', 'variant', 'icon', 'title', 'description'],
    setup: p => () => h('div', { 'data-icon': p.icon }, [h('strong', p.title), ' ', p.description]),
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
    const root = mount({ unidentified: [{ pos: 0, text: 'First' }, { pos: 9, text: 'Second' }] })
    const hold = root.querySelector('[data-testid="review-unidentified"]')
    expect(hold?.textContent).toContain('2 blocks have no id')
    expect(hold?.textContent).toContain('Editing such a block gives it one')
    // Not "nothing is waiting": something is, and it is on screen above this.
    expect(root.querySelector('[data-testid="review-queue-empty"]')).toBeNull()
  })

  it('lists each id-less block and jumps to the one pressed', () => {
    const jumps: Array<number | null> = []
    const root = mount({
      unidentified: [{ pos: 0, text: 'First' }, { pos: 9, text: 'Second' }],
      onJump: row => jumps.push(row.pos),
    })
    const list = root.querySelector('[data-testid="review-unidentified-0"]')!.closest('ul')
    const name = root.querySelector(`[id="${list?.getAttribute('aria-labelledby')}"]`)
    expect(name?.getAttribute('data-testid')).toBe('review-unidentified')
    expect(root.querySelector('[data-testid="review-unidentified-0"]')?.textContent).toBe('First')
    const second = root.querySelector<HTMLButtonElement>('[data-testid="review-unidentified-9"]')
    expect(second?.textContent).toBe('Second')
    second!.click()
    expect(jumps).toEqual([9])
  })

  it('says nothing is waiting only when neither hold stands', () => {
    const root = mount({})
    expect(root.querySelector('[data-testid="review-queue-empty"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="review-unidentified"]')).toBeNull()
  })

  it('lists both holds at once — one is not the other', () => {
    const root = mount({ queue: [ROW], unidentified: [{ pos: 4, text: 'No id here' }] })
    expect(root.querySelector('[data-testid="review-unidentified"]')?.textContent)
      .toContain('One block has no id')
    expect(root.querySelector('[data-testid="review-queue-summary"]')?.textContent)
      .toContain('One change is')
  })

  it('lists an unattributed row under its step, needing a sign-off', () => {
    const root = mount({ queue: [{ ...ROW, state: 'unattributed' }] })
    expect(root.querySelector('[data-testid="review-queue-empty"]')).toBeNull()
    expect(root.querySelector('[data-testid="review-step-peer"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="review-queue-state-b-1"]')?.textContent)
      .toBe('Needs approval — nobody on record wrote it')
  })

  it('names each step section by its heading', () => {
    const root = mount({ queue: [{ ...ROW, steps: ['agent', 'peer'] }] })
    for (const step of ['agent', 'peer']) {
      const section = root.querySelector(`[data-testid="review-step-${step}"]`)!
      const heading = root.querySelector(`[id="${section.getAttribute('aria-labelledby')}"]`)
      expect(heading?.tagName).toBe('H3')
      expect(section.contains(heading)).toBe(true)
    }
  })

  it('offers the sign-off on a removed unattributed row', () => {
    const root = mount({ queue: [{ ...ROW, kind: 'removed', pos: null, text: '', state: 'unattributed' }] })
    expect(root.querySelector('[data-testid="review-queue-state-b-1"]')?.textContent)
      .toBe('Needs approval — nobody on record wrote it')
    expect(root.querySelector('[data-testid="review-queue-approve-b-1"]')?.getAttribute('aria-disabled')).not.toBe('true')
  })
})

/** Three blocks for this reader, one owing both steps, and one somebody else's. */
const QUEUE: ReviewQueueRow[] = [
  {
    ...ROW,
    steps: ['agent', 'peer'],
    approvals: [
      { step: 'agent', label: 'Mark read', refusal: null },
      { step: 'peer', label: 'Mark reviewed', refusal: null },
    ],
  },
  { ...ROW, id: 'b-2', text: 'Another' },
  { ...ROW, id: 'b-4', text: 'A third' },
  {
    ...ROW,
    id: 'b-3',
    text: 'Mine',
    state: 'awaiting-others',
    approvals: [{ step: 'peer', label: 'Mark reviewed', refusal: 'This block needs a second pair of eyes.' }],
  },
]

/** The "Approve all" button, or null where none is drawn. */
const signOffAll = (root: HTMLElement) =>
  root.querySelector<HTMLButtonElement>('[data-testid="review-sign-off-all"]')

describe('Approve all', () => {
  it('is offered from two changes that are this reader\'s', () => {
    expect(signOffAll(mount({ queue: [ROW] }))).toBeNull()
    expect(signOffAll(mount({ queue: QUEUE }))?.textContent).toBe('Approve all 3')
  })

  it('counts changes, as the line above it does', () => {
    const root = mount({ queue: QUEUE })
    expect(root.querySelector('[data-testid="review-queue-reviewable"]')?.textContent?.trim())
      .toBe('You can approve 3 of them.')
    expect(signOffAll(root)?.textContent).toBe('Approve all 3')
  })

  it('offers the remaining ones once this reader signed something off', () => {
    expect(signOffAll(mount({ queue: QUEUE, signedOff: true }))?.textContent).toBe('Approve the remaining 3')
  })

  it('leaves out what Drupal just refused this reader', () => {
    expect(signOffAll(mount({ queue: QUEUE, refused: ['peer:b-2'] }))?.textContent).toBe('Approve all 2')
    // b-1 still owes its peer step.
    expect(signOffAll(mount({ queue: QUEUE, refused: ['agent:b-1'] }))?.textContent).toBe('Approve all 3')
    const root = mount({ queue: QUEUE, refused: ['peer:b-2', 'peer:b-4'] })
    expect(signOffAll(root)).toBeNull()
    expect(root.querySelector('[data-testid="review-queue-reviewable"]')?.textContent?.trim())
      .toBe('You can approve 1 of them.')
  })

  it('asks first, with a warning and the count, and sends the list on confirm', async () => {
    const sent: unknown[] = []
    const root = mount({ queue: QUEUE, onApproveAll: e => sent.push(e) })
    signOffAll(root)!.click()
    await nextTick()
    const dialog = root.querySelector('[data-testid="modal"]')
    expect(dialog?.querySelector('h2')?.textContent).toBe('Are you sure you want to approve 3 changes?')
    const warning = dialog?.querySelector('[data-testid="review-sign-off-all-warning"]')
    // Focus opens on Cancel; screen readers get the warning as the description.
    expect(warning?.id).toBeTruthy()
    expect(dialog?.getAttribute('aria-describedby')).toBe(warning?.id)
    expect(warning?.getAttribute('data-icon')).toBe('i-lucide-triangle-alert')
    expect(warning?.textContent).toBe('You confirm that you have reviewed every one of them. The page history records this approval under your name.')
    expect(dialog?.textContent).toContain('1 change cannot be approved by you and still needs approval.')
    expect(dialog?.querySelector('[data-testid="review-sign-off-all-confirm"]')?.textContent?.trim()).toBe('Approve 3 changes')
    expect(sent).toEqual([])

    root.querySelector<HTMLButtonElement>('[data-testid="review-sign-off-all-confirm"]')!.click()
    await nextTick()
    expect(sent).toEqual([{
      items: [
        { item: 'b-1', step: 'agent' },
        { item: 'b-1', step: 'peer' },
        { item: 'b-2', step: 'peer' },
        { item: 'b-4', step: 'peer' },
      ],
      waiting: 1,
    }])
    expect(root.querySelector('[data-testid="modal"]')).toBeNull()
  })

  it('counts a partly signable change as waiting on somebody else too', async () => {
    const root = mount({ queue: QUEUE, refused: ['agent:b-1'] })
    signOffAll(root)!.click()
    await nextTick()
    const dialog = root.querySelector('[data-testid="modal"]')
    expect(dialog?.querySelector('h2')?.textContent).toBe('Are you sure you want to approve 3 changes?')
    expect(dialog?.textContent).toContain('2 changes cannot be approved by you and still need approval.')
  })

  it('sends nothing on cancel', async () => {
    const sent: unknown[] = []
    const root = mount({ queue: QUEUE, onApproveAll: e => sent.push(e) })
    signOffAll(root)!.click()
    await nextTick()
    root.querySelector<HTMLButtonElement>('[data-testid="review-sign-off-all-cancel"]')!.click()
    await nextTick()
    expect(sent).toEqual([])
    expect(root.querySelector('[data-testid="modal"]')).toBeNull()
  })
})
