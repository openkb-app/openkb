// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import AssigneePicker from './AssigneePicker.vue'
import AssigneeChip from './AssigneeChip.vue'
import { assigneeCandidates } from '../comment-assignee'
import type { CommentAssignee } from '#shared/block-comments'
import type { PresencePeer } from '#shared/utils/presence'

/**
 * The two pieces of the assignee surface in a bare Vue app.
 *
 * Nuxt UI's popover and command palette are stubbed down to what they hand the
 * component: a trigger, a list of groups, a highlighted row, the item that was
 * chosen and the moment the closing palette hands focus back. Asserted is what
 * the picker offers, what it emits, the one key it handles itself — Tab — and
 * where it leaves the caret.
 */

interface PaletteGroup {
  id: string
  label?: string
  items: Array<{ id: string, label: string, suffix?: string, onSelect: () => void }>
}

/**
 * The palette, flattened: one button per item, in the order it would list them.
 * Rows are options, as the palette's own are, with `highlighted` the index the
 * arrow keys have landed on.
 */
function stubPalette(app: ReturnType<typeof createApp>, highlighted: number): void {
  app.component('UCommandPalette', {
    props: ['groups', 'searchTerm', 'placeholder', 'modelValue', 'by'],
    emits: ['update:searchTerm'],
    setup: (props, { slots, emit }) => () => {
      // Rows are numbered across the list, the way the arrow keys move; a
      // group's heading is drawn with the group, and a group with no items is
      // not in the list at all.
      let row = 0
      return h('div', [h('input', {
        'data-testid': 'palette-search',
        'value': props.searchTerm,
        'onInput': (event: Event) => emit('update:searchTerm', (event.target as HTMLInputElement).value),
      }), ...(props.groups as PaletteGroup[]).flatMap(group => [
        ...(group.label ? [h('p', { 'data-group-label': group.id }, group.label)] : []),
        ...group.items.map(item =>
          h('button', {
            'role': 'option',
            ...(row++ === highlighted ? { 'data-highlighted': '' } : {}),
            'data-group': group.id,
            'data-suffix': item.suffix ?? '',
            // The palette marks the row its model value names.
            'aria-selected': String(item.id === (props.modelValue as { id: string } | undefined)?.id),
            'onClick': item.onSelect,
          }, [slots['item-leading']?.({ item }), item.label])),
      ])])
    },
  })
  app.component('UPopover', {
    props: ['content', 'open'],
    setup: (props, { slots }) => () => h('div', [
      slots.default?.(),
      // The focus scope reka wraps the content in, and the one event of its
      // own the picker listens for (see `closePalette`).
      h('div', {
        'data-testid': 'palette-scope',
        'onClosefocus': (event: Event) =>
          (props.content as { onCloseAutoFocus?: (event: Event) => void } | undefined)?.onCloseAutoFocus?.(event),
      }, slots.content?.()),
    ]),
  })
  app.component('UButton', {
    props: ['icon', 'color', 'variant', 'size', 'title'],
    setup: (_props, { slots }) => () => h('button', slots.default?.()),
  })
  app.component('UAvatar', { props: ['text', 'size', 'ui'], render: () => h('span') })
  app.component('UIcon', { props: ['name'], render: () => h('span') })
}

function mount(component: unknown, props: Record<string, unknown>, highlighted = 0): HTMLElement {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp({ render: () => h(component as never, props) })
  stubPalette(app, highlighted)
  app.mount(root)
  return root
}

/**
 * The picker with `open` in the test's hands, so opening it is a change the
 * component sees — which is when it reads what had the caret.
 */
function mountOpenable(props: Record<string, unknown>) {
  const open = ref(false)
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp({
    render: () => h(AssigneePicker as never, {
      ...props,
      'open': open.value,
      'onUpdate:open': (value: boolean) => { open.value = value },
    }),
  })
  stubPalette(app, 0)
  app.mount(root)
  return { root, open }
}

/** Replays reka's "the closing palette is handing focus back". */
function closePalette(root: HTMLElement): boolean {
  const event = new CustomEvent('closefocus', { cancelable: true })
  root.querySelector('[data-testid="palette-scope"]')!.dispatchEvent(event)
  return event.defaultPrevented
}

/** The palette row naming `label`. */
function rowFor(root: HTMLElement, label: string): HTMLButtonElement {
  return [...root.querySelectorAll<HTMLButtonElement>('[data-testid="assignee-picker"] button')]
    .find(button => button.textContent?.includes(label))!
}

/** The keydown the palette sees, and whether the picker swallowed it. */
function press(root: HTMLElement, init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  root.querySelector('[data-testid="assignee-picker"]')!.dispatchEvent(event)
  return event.defaultPrevented
}

function peer(clientId: number, name: string, uid: number, via?: string): PresencePeer {
  return { clientId, name, uid, color: '#336699', isSelf: false, ...(via ? { via } : {}) }
}

/** A space roster of `count` editors, none of them in the page. */
function editors(count: number): Array<{ uid: number, name: string }> {
  return Array.from({ length: count }, (_, at) => ({ uid: 100 + at, name: `editor${at + 1}` }))
}

const READER = 42

/** The reader's own agents, with the reader themself left out of the list. */
function mine(agents: string[], peers: PresencePeer[] = [], roster: Array<{ uid: number, name: string }> = []) {
  return assigneeCandidates(peers, roster, {
    uid: READER,
    name: 'Reader',
    agents: agents.map(label => ({ label })),
  })
}

const CANDIDATES = assigneeCandidates(
  [peer(1, 'Ada', 7), peer(2, 'Ada', 7, 'Claude')],
  [{ uid: 9, name: 'Bob' }],
)

/** The labels of the rows the palette marks as the form's choice. */
function marked(root: HTMLElement): Array<string | null> {
  return [...root.querySelectorAll('[data-testid="assignee-picker"] button[aria-selected="true"]')]
    .map(button => button.textContent)
}

/** Every palette row, in list order, with the group it is listed under. */
function entries(root: HTMLElement): Array<{ label: string, group: string }> {
  return [...root.querySelectorAll('[data-testid="assignee-picker"] button')].map(button => ({
    label: button.textContent ?? '',
    group: button.getAttribute('data-group') ?? '',
  }))
}

describe('AssigneePicker', () => {
  it('offers the people in the page, the space, then the agents', () => {
    const root = mount(AssigneePicker, { candidates: CANDIDATES, open: true })

    expect(entries(root)).toEqual([
      { label: 'Ada', group: 'here' },
      { label: 'Bob', group: 'space' },
      { label: 'Ada via Claude', group: 'agents' },
    ])
  })

  it('marks an agent row the way the presence strip marks one', () => {
    const root = mount(AssigneePicker, { candidates: CANDIDATES, open: true })

    expect([...root.querySelectorAll('[data-testid="assignee-picker"] button')]
      .map(button => !!button.querySelector('[data-testid="agent-badge"]')))
      .toEqual([false, false, true])
  })

  it('heads a group only where it has somebody to offer', () => {
    const withAgent = mount(AssigneePicker, {
      candidates: mine(['Claude'], [peer(1, 'Ada', 7)]),
      open: true,
      viewerUid: READER,
    })
    expect(withAgent.querySelector('[data-group-label="my-agents"]')?.textContent).toBe('My agents')

    const none = mount(AssigneePicker, {
      candidates: mine([], [peer(1, 'Ada', 7)]),
      open: true,
      viewerUid: READER,
    })
    expect(none.querySelector('[data-group-label="my-agents"]')).toBeNull()
  })

  it('never offers the reader themself — a thread is handed to somebody else', () => {
    const root = mount(AssigneePicker, {
      candidates: mine(['Claude'], [peer(1, 'Reader', READER), peer(2, 'Ada', 7)], [{ uid: READER, name: 'Reader' }]),
      open: true,
      viewerUid: READER,
    })

    expect(entries(root)).toEqual([
      { label: 'Ada', group: 'here' },
      { label: 'Claude', group: 'my-agents' },
    ])
  })

  it('says which of them have the page open right now', () => {
    const root = mount(AssigneePicker, { candidates: CANDIDATES, open: true })
    const suffixes = [...root.querySelectorAll('[data-testid="assignee-picker"] button')]
      .map(button => button.getAttribute('data-suffix'))

    expect(suffixes).toEqual(['In the page now', '', 'In the page now'])
  })

  // One short word: the row is as wide as the drawer, and a longer status is
  // cut off mid-word there.
  it('says an absent agent is offline', () => {
    const root = mount(AssigneePicker, {
      candidates: mine(['Claude'], [peer(1, 'Ada', 7)]),
      open: true,
      viewerUid: READER,
    })

    expect(rowFor(root, 'Claude').getAttribute('data-suffix')).toBe('Offline')
  })

  // The assistant works from the reader's open chat, never from the page.
  it('gives the AI assistant no presence', () => {
    const root = mount(AssigneePicker, {
      candidates: mine(['Claude', 'AI assistant'], [peer(1, 'Ada', 7)]),
      open: true,
      viewerUid: READER,
    })

    expect(rowFor(root, 'AI assistant').getAttribute('data-suffix')).toBe('')
  })

  // The list does not scroll, so it rests at what fits under the composer.
  it('rests at eight rows, the reader\'s own agent among them', () => {
    const root = mount(AssigneePicker, {
      candidates: mine(['Claude'], [peer(1, 'Ada', 7)], editors(12)),
      open: true,
      viewerUid: READER,
    })
    const rows = entries(root)

    expect(rows).toHaveLength(8)
    expect(rows.filter(row => row.group === 'here')).toHaveLength(1)
    expect(rows.filter(row => row.group === 'my-agents')).toHaveLength(1)
    // What gives way is the roster, which is the only group that grows.
    expect(rows.filter(row => row.group === 'space')).toHaveLength(6)
  })

  it('rests with the form\'s choice shown and marked, however far down the roster', () => {
    const root = mount(AssigneePicker, {
      candidates: mine([], [], editors(30)),
      open: true,
      viewerUid: READER,
      selected: { uid: 124, name: 'editor25', via: null },
    })

    const rows = entries(root).filter(row => row.group !== 'none')
    expect(rows).toHaveLength(8)
    expect(marked(root)).toEqual(['editor25'])
    // The kept row stays at its place in the group.
    expect(rows.map(row => row.label)).toEqual([
      'editor1', 'editor2', 'editor3', 'editor4', 'editor5', 'editor6', 'editor7', 'editor25',
    ])
  })

  it('lists the AI assistant at its own place in its group, short roster or long', () => {
    const agents = ['Claude', 'Codex', 'AI assistant']
    const short = mount(AssigneePicker, { candidates: mine(agents), open: true, viewerUid: READER })
    const long = mount(AssigneePicker, {
      candidates: mine(agents, [], editors(12)),
      open: true,
      viewerUid: READER,
    })

    /** The labels of the rows listed under "My agents". */
    const ownAgents = (root: HTMLElement) =>
      entries(root).filter(row => row.group === 'my-agents').map(row => row.label)
    expect(ownAgents(short)).toEqual(['Claude', 'Codex', 'AI assistant'])
    expect(ownAgents(long).at(-1)).toBe('AI assistant')
  })

  // A thread assigned to the reader: the reader is no candidate, but the
  // reply's menu names them on its button, so the list holds them too.
  it('lists and marks the form\'s choice when it is no candidate', () => {
    const reader = mount(AssigneePicker, {
      candidates: mine(['Claude'], [peer(1, 'Ada', 7)]),
      open: true,
      viewerUid: READER,
      selected: { uid: READER, name: 'Reader', via: null },
    })
    expect(entries(reader)[0]).toEqual({ label: 'Reader', group: 'unlisted' })
    expect(marked(reader)).toEqual(['Reader'])

    const goneAgent = mount(AssigneePicker, {
      candidates: CANDIDATES,
      open: true,
      selected: { uid: 9, name: 'Bob', via: 'Codex' },
    })
    expect(rowFor(goneAgent, 'Bob via Codex').getAttribute('data-suffix')).toBe('Offline')
    expect(marked(goneAgent)).toEqual(['Bob via Codex'])
  })

  it('rests with the reader\'s AI assistant shown, behind other agents of theirs', () => {
    const root = mount(AssigneePicker, {
      candidates: mine(['Claude', 'Codex', 'Gemini', 'AI assistant'], [peer(1, 'Ada', 7)], editors(12)),
      open: true,
      viewerUid: READER,
      selected: null,
    })

    expect(entries(root).filter(row => row.group !== 'none')).toHaveLength(8)
    expect(rowFor(root, 'AI assistant')).toBeTruthy()
  })

  // Nothing is hidden from the search: the cap is what the list rests at, and
  // the palette does the narrowing over every candidate.
  it('hands the palette everybody once something is typed', async () => {
    const root = mount(AssigneePicker, {
      candidates: mine(['Claude'], [peer(1, 'Ada', 7)], editors(12)),
      open: true,
      viewerUid: READER,
    })

    const search = root.querySelector<HTMLInputElement>('[data-testid="palette-search"]')!
    search.value = 'editor'
    search.dispatchEvent(new Event('input'))
    await nextTick()

    expect(entries(root)).toHaveLength(14)
    expect(rowFor(root, 'editor12')).toBeTruthy()
  })

  it('offers unassigning only where there is somebody to unassign', () => {
    const without = mount(AssigneePicker, { candidates: CANDIDATES, open: true })
    expect(entries(without).some(entry => entry.label === 'Unassign')).toBe(false)

    const with_ = mount(AssigneePicker, { candidates: CANDIDATES, open: true, allowUnassign: true })
    expect(entries(with_).at(-1)).toEqual({ label: 'Unassign', group: 'none' })
  })

  it('offers Nobody to a form, and marks the choice the form holds', () => {

    const chosen = mount(AssigneePicker, {
      candidates: CANDIDATES,
      open: true,
      selected: { uid: 7, name: 'Ada', via: 'Claude' },
    })
    expect(entries(chosen).at(-1)).toEqual({ label: 'Nobody', group: 'none' })
    expect(marked(chosen)).toEqual(['Ada via Claude'])

    const nobody = mount(AssigneePicker, { candidates: CANDIDATES, open: true, selected: null })
    expect(marked(nobody)).toEqual(['Nobody'])

    // Without a choice to show, nothing is marked.
    const bare = mount(AssigneePicker, { candidates: CANDIDATES, open: true, allowUnassign: true })
    expect(marked(bare)).toEqual([])
  })

  // The thread's chip: its assignee is marked, and "Unassign" is the way to nobody.
  it('marks the thread\'s assignee in the chip\'s menu, with Unassign in place of Nobody', () => {
    const chip = mount(AssigneePicker, {
      candidates: CANDIDATES,
      open: true,
      allowUnassign: true,
      selected: { uid: 7, name: 'Ada', via: 'Claude' },
    })

    expect(marked(chip)).toEqual(['Ada via Claude'])
    expect(entries(chip).filter(entry => entry.group === 'none').map(entry => entry.label)).toEqual(['Unassign'])
  })

  // A reply on a thread assigned to the reader, once "Nobody" is picked: the
  // reader is no candidate, yet stays on offer to go back to.
  it('keeps listing the thread\'s assignee once the form\'s choice moved off it', () => {
    const root = mount(AssigneePicker, {
      candidates: mine(['Claude'], [peer(1, 'Ada', 7)], editors(12)),
      open: true,
      viewerUid: READER,
      selected: null,
      assigned: { uid: READER, name: 'Reader', via: null },
    })

    expect(entries(root)[0]).toEqual({ label: 'Reader', group: 'unlisted' })
    expect(entries(root).filter(row => row.group !== 'none')).toHaveLength(8)
    expect(marked(root)).toEqual(['Nobody'])
  })

  it('lists an unlisted assignee once when it is both the choice and the thread\'s', () => {
    const reader = { uid: READER, name: 'Reader', via: null }
    const root = mount(AssigneePicker, {
      candidates: mine(['Claude'], [peer(1, 'Ada', 7)]),
      open: true,
      viewerUid: READER,
      selected: reader,
      assigned: reader,
    })

    expect(entries(root).filter(row => row.group === 'unlisted')).toEqual([{ label: 'Reader', group: 'unlisted' }])
    expect(marked(root)).toEqual(['Reader'])
  })

  it('rests with the choice, the thread\'s assignee and the AI assistant shown, all three agents of the reader', () => {
    const root = mount(AssigneePicker, {
      candidates: mine(
        ['Claude', 'Codex', 'AI assistant'],
        [peer(1, 'Ada', 7), peer(2, 'Bob', 9), peer(3, 'Cy', 11), peer(4, 'Ada', 7, 'Claude'), peer(5, 'Bob', 9, 'Gemini')],
        editors(12),
      ),
      open: true,
      viewerUid: READER,
      selected: { uid: READER, name: 'Reader', via: 'Codex' },
      assigned: { uid: READER, name: 'Reader', via: 'Claude' },
    })
    const rows = entries(root).filter(row => row.group !== 'none')

    expect(rows).toHaveLength(8)
    expect(rows.filter(row => row.group === 'my-agents').map(row => row.label))
      .toEqual(['Claude', 'Codex', 'AI assistant'])
  })

  it('hands back nobody when Nobody is picked', () => {
    const picked: Array<CommentAssignee | null> = []
    const root = mount(AssigneePicker, {
      candidates: CANDIDATES,
      open: true,
      selected: { uid: 9, name: 'Bob', via: null },
      onPick: (who: CommentAssignee | null) => picked.push(who),
    })

    rowFor(root, 'Nobody').click()

    expect(picked).toEqual([null])
  })

  it('picks the highlighted suggestion on Tab, arrows and all', () => {
    const picked: Array<CommentAssignee | null> = []
    const root = mount(AssigneePicker, {
      candidates: CANDIDATES,
      open: true,
      onPick: (who: CommentAssignee | null) => picked.push(who),
    }, 1)

    expect(press(root, { key: 'Tab' })).toBe(true)
    expect(picked).toEqual([{ uid: 9, name: 'Bob', via: null }])
  })

  it('lets Shift+Tab out of the picker, picking nobody', () => {
    const picked: Array<CommentAssignee | null> = []
    const root = mount(AssigneePicker, {
      candidates: CANDIDATES,
      open: true,
      onPick: (who: CommentAssignee | null) => picked.push(who),
    })

    expect(press(root, { key: 'Tab', shiftKey: true })).toBe(false)
    expect(picked).toEqual([])
  })

  it('leaves the picker alone on Tab when it offers nothing', () => {
    const picked: Array<CommentAssignee | null> = []
    const root = mount(AssigneePicker, {
      candidates: [],
      open: true,
      onPick: (who: CommentAssignee | null) => picked.push(who),
    })

    expect(press(root, { key: 'Tab' })).toBe(false)
    expect(picked).toEqual([])
  })

  it('hands the caret back to the composer the pick was started from', async () => {
    const composer = document.createElement('textarea')
    document.body.append(composer)
    composer.focus()
    const { root, open } = mountOpenable({ candidates: CANDIDATES, onPick: () => {} })
    open.value = true
    await nextTick()

    const row = rowFor(root, 'Bob')
    row.focus()
    row.click()
    await nextTick()

    expect(closePalette(root)).toBe(true)
    expect(document.activeElement).toBe(composer)
  })

  // The palette hands focus back a frame after it closes. A press in that frame
  // owns the caret, and taking it back lands it on a composer that press is
  // closing — a detached node, which the drawer reads as a press outside it.
  it('leaves the caret where a press elsewhere has already taken it', async () => {
    const composer = document.createElement('textarea')
    const post = document.createElement('button')
    document.body.append(composer, post)
    composer.focus()
    const { root, open } = mountOpenable({ candidates: CANDIDATES, onPick: () => {} })
    open.value = true
    await nextTick()

    rowFor(root, 'Bob').click()
    await nextTick()
    post.focus()

    expect(closePalette(root)).toBe(false)
    expect(document.activeElement).toBe(post)
  })

  it('hands back the identity that was picked, agent label and all', () => {
    const picked: Array<CommentAssignee | null> = []
    const root = mount(AssigneePicker, {
      candidates: CANDIDATES,
      open: true,
      allowUnassign: true,
      onPick: (who: CommentAssignee | null) => picked.push(who),
    })
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-testid="assignee-picker"] button')]

    buttons[2]!.click()
    buttons[3]!.click()

    expect(picked).toEqual([{ uid: 7, name: 'Ada', via: 'Claude' }, null])
  })
})

describe('AssigneeChip', () => {
  it('reads as a person, and names what pressing it does', () => {
    const root = mount(AssigneeChip, { assignee: { uid: 9, name: 'Bob' } })
    const chip = root.querySelector('button')!

    expect(chip.textContent).toContain('Bob')
    expect(chip.getAttribute('aria-label')).toBe('Assigned to Bob — change')
  })

  it('names an agent by its label, and says whose it is', () => {
    const root = mount(AssigneeChip, { assignee: { uid: 7, name: 'Ada', via: 'Claude' } })

    expect(root.querySelector('button')!.textContent).toContain('Ada via Claude')
  })

  it('names the owner\'s own agent by its bare name', () => {
    const root = mount(AssigneeChip, {
      assignee: { uid: 7, name: 'Ada', via: 'Claude' },
      viewerUid: 7,
    })

    expect(root.querySelector('button')!.textContent).toContain('Claude')
    expect(root.querySelector('button')!.getAttribute('aria-label')).toBe('Assigned to Claude — change')
  })
})
