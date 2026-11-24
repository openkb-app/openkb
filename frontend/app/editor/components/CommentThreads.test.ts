// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'
import CommentThreads from './CommentThreads.vue'
import type { CommentDraft, CommentThreadView, ShownThreads } from '../comment-marks'
import { assigneeCandidates } from '../comment-assignee'
import type { CommentAssignee } from '#shared/block-comments'
import type { PresencePeer } from '#shared/utils/presence'

/**
 * The composer half of the drawer, in a bare Vue app.
 *
 * Nuxt UI is stubbed down to what the component drives: a real `<textarea>` and
 * a picker that hands back {@link nextPick} and closes. The mention field is
 * the real one, so the echo behind the text is asserted here too.
 */

interface PickerProps {
  candidates: unknown[]
  open?: boolean
  selected?: CommentAssignee | null
  assigned?: CommentAssignee | null
}

const ADAS_AGENT: CommentAssignee = { uid: 7, name: 'Ada', via: 'Claude' }
const DRAFT: CommentDraft = { blockId: 'b-1', anchor: null, label: 'Image: Probe chart' }

/** The accounts the name lookup answers, by uid. */
const currentNames = new Map<number, string>([[7, 'Ada'], [3, 'Bob']])
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const uids = new URL(url, 'http://localhost').searchParams.get('uid')?.split(',').map(Number) ?? []
    const users = uids.filter(uid => currentNames.has(uid)).map(uid => ({ uid, name: currentNames.get(uid) }))
    return new Response(JSON.stringify({ users }))
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

/** Waits until a send has written the draft as stored text and emitted it. */
async function sent(): Promise<void> {
  for (let round = 0; round < 3; round++) {
    await import('comark/render')
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

/** Waits until message texts are parsed and drawn. */
async function drawn(): Promise<void> {
  await import('comark')
  for (let round = 0; round < 3; round++) {
    await new Promise(resolve => setTimeout(resolve, 0))
    await nextTick()
  }
}

/** What a press on the stubbed picker picks; null is its "Nobody" row. */
let nextPick: CommentAssignee | null = ADAS_AGENT
beforeEach(() => { nextPick = ADAS_AGENT })

/** The props a test changes after mounting. */
interface LiveProps {
  draft?: CommentDraft | null
  defaultAssignee?: CommentAssignee | null
  candidates?: ReturnType<typeof assigneeCandidates>
}

function mount(
  candidates: ReturnType<typeof assigneeCandidates>,
  threads: CommentThreadView[] = [],
  shownFor: ShownThreads | null = null,
  me: { uid: number, name: string } | null = null,
  live: LiveProps = {},
) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const posted: unknown[] = []
  const replied: unknown[] = []
  const assigned: unknown[] = []
  const app = createApp({
    render: () => h(CommentThreads as never, {
      threads,
      draft: DRAFT,
      shownFor,
      candidates,
      me,
      ...live,
      onPost: (payload: unknown) => posted.push(payload),
      onReply: (payload: unknown) => replied.push(payload),
      onAssign: (payload: unknown) => assigned.push(payload),
    }),
  })
  app.component('UTabs', {
    props: ['items', 'content', 'modelValue'],
    setup: props => () => h('div', { 'data-stub': 'tabs' }, (props.items as {
      label: string
      badge?: number
    }[]).map(item => h('span', { 'data-tab': item.label }, String(item.badge ?? '')))),
  })
  app.component('UButton', {
    props: ['icon', 'color', 'variant', 'size', 'disabled', 'block', 'title'],
    setup: (_props, { slots }) => () => h('button', slots.default?.()),
  })
  app.component('UTextarea', {
    props: ['modelValue', 'rows', 'autofocus', 'placeholder'],
    emits: ['update:modelValue'],
    setup: (props, { emit, attrs }) => () => h('textarea', {
      ...attrs,
      'value': props.modelValue,
      'data-stub': 'textarea',
      'onInput': (event: Event) => {
        emit('update:modelValue', (event.target as HTMLTextAreaElement).value)
        ;(attrs.onInput as ((e: Event) => void) | undefined)?.(event)
      },
    }),
  })
  // The picker is exercised through the identity it emits, not through the
  // palette — that has a suite of its own.
  app.component('EditorAssigneePicker', {
    props: ['candidates', 'open', 'allowUnassign', 'selected', 'assigned'],
    emits: ['pick', 'update:open'],
    setup: (props: PickerProps, { slots, emit }) => () => h('div', {
      'data-stub': 'picker',
      'data-open': String(!!props.open),
      'data-selected': props.selected === undefined ? '' : JSON.stringify(props.selected),
      'data-assigned': props.assigned === undefined ? '' : JSON.stringify(props.assigned),
      'onClick': () => {
        emit('pick', nextPick)
        emit('update:open', false)
      },
    }, slots.default?.()),
  })
  app.component('EditorAssigneeChip', { props: ['assignee', 'viewerUid'], render: () => h('span', { 'data-stub': 'chip' }) })
  app.mount(root)
  return { root, posted, replied, assigned }
}

const AT = 1_700_000_000_000

function peer(clientId: number, name: string, uid: number, via?: string): PresencePeer {
  return { clientId, name, uid, color: '#336699', isSelf: false, ...(via ? { via } : {}) }
}

const CANDIDATES = assigneeCandidates([peer(1, 'Ada', 7), peer(2, 'Ada', 7, 'Claude')], [])

/** Types one character into the draft the way a browser reports it. */
async function type(root: HTMLElement, char: string): Promise<HTMLTextAreaElement> {
  const field = root.querySelector<HTMLTextAreaElement>('[data-stub="textarea"]')!
  field.value += char
  field.selectionStart = field.value.length
  field.dispatchEvent(new (window as never as { InputEvent: typeof InputEvent }).InputEvent('input', {
    data: char,
    bubbles: true,
  }))
  await nextTick()
  return field
}

/** One open thread, as the drawer lists it. */
const THREAD: CommentThreadView = {
  blockId: 'b-1',
  threadId: 'c-1',
  anchor: null,
  messages: [{ id: 'm-a', uid: 7, name: 'Ada', via: null, at: AT, text: 'is this right?' }],
  resolved: false,
  assignee: null,
  assignedTo: [],
  assignedBy: null,
  handling: null,
  openedAt: AT,
  lastAt: AT,
  blockText: 'The quick brown fox',
}

/** Presses Enter on a textarea, with whichever modifier the reader holds. */
function press(field: HTMLTextAreaElement, modifier: 'ctrlKey' | 'metaKey' | null): void {
  field.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    ...(modifier ? { [modifier]: true } : {}),
  }))
}

/** The new comment's assignee menu. */
const picker = (root: HTMLElement) => root.querySelector('[data-stub="picker"]')!
/** The assignee menu of the reply box on thread `threadId`. */
const replyPicker = (root: HTMLElement, threadId: string) => root
  .querySelector(`[data-testid="comment-reply-assignee-${threadId}"]`)!
  .closest<HTMLElement>('[data-stub="picker"]')!
/** The menu of the thread's assignee chip. */
const chipPicker = (root: HTMLElement) => root
  .querySelector('[data-stub="chip"]')!
  .closest<HTMLElement>('[data-stub="picker"]')!
/** The button that names the draft's assignee and opens the menu. */
const assigneeButton = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-testid="comment-assignee"]')!
/** The new comment's text field. */
const draftField = (root: HTMLElement) => root.querySelector<HTMLTextAreaElement>('[data-stub="textarea"]')!

/** Replaces what a textarea holds, the way a paste or a select-and-delete does. */
async function setText(field: HTMLTextAreaElement, text: string): Promise<void> {
  field.value = text
  field.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}
/** The chips the echo paints behind the draft, in order. */
const echoed = (root: HTMLElement) => [...root.querySelectorAll('[data-testid="mention-echo"] .okb-mention-echo')]
  .map(chip => chip.textContent)

describe('the comment composer', () => {
  it('names a block opened without a passage by its label', () => {
    const { root } = mount(CANDIDATES)
    expect(root.querySelector('[data-testid="comment-draft"] p')!.textContent).toContain('On “Image: Probe chart”')
  })

  it('opens the picker on the @ that has already landed in the draft', async () => {
    const { root } = mount(CANDIDATES)

    expect(picker(root).getAttribute('data-open')).toBe('false')
    const field = await type(root, '@')

    expect(picker(root).getAttribute('data-open')).toBe('true')
    // The character stays where it was typed; the palette opens over a draft
    // that already holds it, never instead of it.
    expect(field.value).toBe('@')
  })

  it('completes a typed @ to a mention and selects who it names', async () => {
    const { root } = mount(CANDIDATES)
    await type(root, '@')

    ;(picker(root) as HTMLElement).click()
    await nextTick()

    // Somebody else's agent is named by its owner too.
    expect(draftField(root).value).toBe('@Ada via Claude ')
    expect(assigneeButton(root).textContent?.trim()).toBe('Ada via Claude')
    expect(picker(root).getAttribute('data-open')).toBe('false')
  })

  it('names the reader\'s own agent by itself', async () => {
    const { root } = mount(CANDIDATES, [], null, { uid: 7, name: 'Ada' })
    await type(root, '@')

    ;(picker(root) as HTMLElement).click()
    await nextTick()

    expect(draftField(root).value).toBe('@Claude ')
    expect(assigneeButton(root).textContent?.trim()).toBe('Claude')
  })

  it('sets the mention off from the prose around it', async () => {
    const { root } = mount(CANDIDATES)
    await type(root, '@')

    ;(picker(root) as HTMLElement).click()
    await nextTick()

    expect(echoed(root)).toEqual(['@Ada via Claude'])
  })

  it('starts with nobody, and says so in the button\'s name', async () => {
    const { root } = mount(CANDIDATES)
    await type(root, 'x')

    expect(picker(root).getAttribute('data-open')).toBe('false')
    expect(assigneeButton(root).textContent?.trim()).toBe('Nobody')
    expect(assigneeButton(root).getAttribute('aria-label')).toBe('Assignee: Nobody')
    expect(picker(root).getAttribute('data-selected')).toBe('null')
    expect(echoed(root)).toEqual([])
  })

  it('selects a pick from the menu and writes nothing into the draft', async () => {
    const { root, posted } = mount(CANDIDATES)
    await type(root, 'x')

    ;(picker(root) as HTMLElement).click()
    await nextTick()

    expect(draftField(root).value).toBe('x')
    expect(assigneeButton(root).getAttribute('aria-label')).toBe('Assignee: Ada via Claude')
    expect(picker(root).getAttribute('data-selected')).toBe(JSON.stringify(ADAS_AGENT))

    root.querySelector<HTMLElement>('[data-testid="comment-post"]')!.click()
    await sent()
    expect(posted).toEqual([{ text: 'x', assignee: ADAS_AGENT }])
  })

  it('writes no mention on a menu pick that follows a completed one', async () => {
    const { root } = mount(CANDIDATES)
    await type(root, '@')
    const stub = picker(root) as HTMLElement
    stub.click()
    await nextTick()
    expect(draftField(root).value).toBe('@Ada via Claude ')

    await setText(draftField(root), 'plain words')
    stub.click()
    await nextTick()

    expect(draftField(root).value).toBe('plain words')
  })

  it('keeps the selection when the mention is deleted again', async () => {
    const { root, posted } = mount(CANDIDATES)
    await type(root, '@')
    ;(picker(root) as HTMLElement).click()
    await nextTick()

    await setText(draftField(root), 'no mention left')

    expect(assigneeButton(root).textContent?.trim()).toBe('Ada via Claude')
    root.querySelector<HTMLElement>('[data-testid="comment-post"]')!.click()
    await sent()
    expect(posted).toEqual([{ text: 'no mention left', assignee: ADAS_AGENT }])
  })

  it('keeps a pick when the candidates change under a mention in the draft', async () => {
    const live = reactive<LiveProps>({ candidates: CANDIDATES })
    const { root } = mount(CANDIDATES, [], null, null, live)
    await type(root, '@')
    ;(picker(root) as HTMLElement).click()
    await nextTick()
    nextPick = null
    ;(picker(root) as HTMLElement).click()
    await nextTick()

    // Ada's agent drops out of the page and comes back.
    live.candidates = assigneeCandidates([peer(1, 'Ada', 7)], [])
    await nextTick()
    live.candidates = CANDIDATES
    await nextTick()

    expect(draftField(root).value).toBe('@Ada via Claude ')
    expect(assigneeButton(root).textContent?.trim()).toBe('Nobody')
  })

  it('keeps the selection when the last of two mentions is deleted', async () => {
    const { root } = mount(CANDIDATES)
    await setText(draftField(root), '@Ada and @Ada via Claude ')
    expect(assigneeButton(root).textContent?.trim()).toBe('Ada via Claude')

    await setText(draftField(root), '@Ada and ')

    expect(assigneeButton(root).textContent?.trim()).toBe('Ada via Claude')
  })

  it('keeps the selection on a Backspace inside a mention', async () => {
    const { root } = mount(CANDIDATES)
    await setText(draftField(root), '@Ada via Claude ')
    nextPick = null
    ;(picker(root) as HTMLElement).click()
    await nextTick()

    await setText(draftField(root), '@Ada via Claude')
    await setText(draftField(root), '@Ada via Claud')

    expect(assigneeButton(root).textContent?.trim()).toBe('Nobody')
  })

  it('reads a name a person and the reader\'s own agent share as the agent, in text and echo', async () => {
    const both = assigneeCandidates(
      [peer(1, 'claude', 9)],
      [],
      { uid: 7, name: 'fago', agents: [{ label: 'claude' }] },
    )
    const { root } = mount(both, [], null, { uid: 7, name: 'fago' })

    await setText(draftField(root), '@claude please check')

    expect(picker(root).getAttribute('data-selected'))
      .toBe(JSON.stringify({ uid: 7, name: 'fago', via: 'claude' }))
    const chips = [...root.querySelectorAll('[data-testid="mention-echo"] .okb-mention-echo')]
    expect(chips.map(chip => chip.classList.contains('okb-mention-echo--agent'))).toEqual([true])
  })

  it('keeps a selected candidate that leaves the list, and posts to it', async () => {
    const live = reactive<LiveProps>({ candidates: CANDIDATES })
    const { root, posted } = mount(CANDIDATES, [], null, null, live)
    await type(root, 'x')
    ;(picker(root) as HTMLElement).click()
    await nextTick()

    live.candidates = assigneeCandidates([peer(1, 'Ada', 7)], [])
    await nextTick()

    expect(assigneeButton(root).textContent?.trim()).toBe('Ada via Claude')
    root.querySelector<HTMLElement>('[data-testid="comment-post"]')!.click()
    await sent()
    expect(posted).toEqual([{ text: 'x', assignee: ADAS_AGENT }])
  })

  it('selects whoever a mention typed out in full names', async () => {
    const { root } = mount(CANDIDATES)

    await setText(draftField(root), 'over to @Ada via Claude now')

    expect(assigneeButton(root).textContent?.trim()).toBe('Ada via Claude')
  })

  it('posts to nobody once Nobody is picked', async () => {
    const assistant = { uid: 7, name: 'Ada', via: 'AI assistant' }
    const { root, posted } = mount(CANDIDATES, [], null, { uid: 7, name: 'Ada' }, { defaultAssignee: assistant })
    await type(root, 'x')
    expect(assigneeButton(root).getAttribute('aria-label')).toBe('Assignee: AI assistant')

    nextPick = null
    ;(picker(root) as HTMLElement).click()
    await nextTick()

    expect(assigneeButton(root).textContent?.trim()).toBe('Nobody')
    root.querySelector<HTMLElement>('[data-testid="comment-post"]')!.click()
    await sent()
    expect(posted).toEqual([{ text: 'x', assignee: null }])
  })

  it('fixes the preselection when the draft opens, and takes the new one with the next draft', async () => {
    const assistant = { uid: 7, name: 'Ada', via: 'AI assistant' }
    const live = reactive<LiveProps>({ draft: DRAFT, defaultAssignee: assistant })
    const { root, posted } = mount(CANDIDATES, [], null, { uid: 7, name: 'Ada' }, live)
    expect(assigneeButton(root).textContent?.trim()).toBe('AI assistant')

    // The chat is folded while the draft is open.
    live.defaultAssignee = null
    await nextTick()
    expect(assigneeButton(root).textContent?.trim()).toBe('AI assistant')
    await type(root, 'x')
    root.querySelector<HTMLElement>('[data-testid="comment-post"]')!.click()
    await sent()
    expect(posted).toEqual([{ text: 'x', assignee: assistant }])

    live.draft = { ...DRAFT, blockId: 'b-2' }
    await nextTick()
    expect(assigneeButton(root).textContent?.trim()).toBe('Nobody')
  })
})

describe('the filters over the list', () => {
  const tabs = (root: HTMLElement) => [...root.querySelectorAll('[data-tab]')]
    .map(tab => [tab.getAttribute('data-tab'), tab.textContent])

  const MINE = { ...THREAD, threadId: 'c-2', assignee: { uid: 7, name: 'Ada', via: null } }
  const MY_AGENT = { ...THREAD, threadId: 'c-3', assignee: { uid: 7, name: 'Ada', via: 'Claude' } }

  it('counts what I was handed apart from what my agents were', () => {
    const { root } = mount(CANDIDATES, [THREAD, MINE, MY_AGENT], null, { uid: 7, name: 'Ada' })

    expect(tabs(root)).toEqual([
      ['Assigned to me', '1'],
      ['Assigned to my agents', '1'],
      ['All', ''],
    ])
  })

  it('offers no agents filter to a reader with no agent of their own', () => {
    const people = assigneeCandidates([peer(1, 'Ada', 7), peer(2, 'Bob', 9)], [])
    const { root } = mount(people, [THREAD, MINE], null, { uid: 9, name: 'Bob' })

    expect(tabs(root).map(([label]) => label)).toEqual(['Assigned to me', 'All'])
  })
})

describe('handing a thread on from a reply', () => {
  /** Opens the reply box on the one thread. */
  async function openReply(root: HTMLElement): Promise<HTMLTextAreaElement> {
    root.querySelector<HTMLElement>('[data-testid="comment-reply-c-1"]')!.click()
    await nextTick()
    return root.querySelector<HTMLTextAreaElement>(
      '[aria-label="Reply to the comment on The quick brown fox"]',
    )!
  }

  const ASSIGNED: CommentThreadView = { ...THREAD, assignee: ADAS_AGENT, assignedTo: [ADAS_AGENT] }
  /** The button that names the reply's assignee and opens its menu. */
  const replyButton = (root: HTMLElement) =>
    root.querySelector<HTMLElement>('[data-testid="comment-reply-assignee-c-1"]')!

  it('hands the thread on to a menu pick when the reply is posted, with no mention written', async () => {
    const { root, replied, assigned } = mount(CANDIDATES, [THREAD])
    const field = await openReply(root)
    expect(replyButton(root).getAttribute('aria-label')).toBe('Assignee: Nobody')

    replyPicker(root, 'c-1').click()
    await nextTick()
    expect(field.value).toBe('')
    expect(replyButton(root).getAttribute('aria-label')).toBe('Assignee: Ada via Claude')
    // Nothing is handed on before the reply is posted.
    expect(assigned).toEqual([])

    await setText(field, 'Agreed.')
    press(field, 'ctrlKey')

    expect(assigned).toEqual([{ blockId: 'b-1', threadId: 'c-1', assignee: ADAS_AGENT }])
    await sent()
    expect(replied).toEqual([{ blockId: 'b-1', threadId: 'c-1', text: 'Agreed.' }])
  })

  it('assigns the thread, not the reply, to whoever the reply mentions', async () => {
    const { root, replied, assigned } = mount(CANDIDATES, [THREAD])
    const field = await openReply(root)

    await setText(field, 'over to @Ada via Claude now')
    press(field, 'ctrlKey')

    expect(assigned).toEqual([{ blockId: 'b-1', threadId: 'c-1', assignee: ADAS_AGENT }])
    await sent()
    expect(replied).toEqual([{ blockId: 'b-1', threadId: 'c-1', text: 'over to :mention[Ada via Claude]{uid="7" via="Claude"} now' }])
  })

  it('leaves the thread where it is when the reply leaves the selection alone', async () => {
    const { root, replied, assigned } = mount(CANDIDATES, [ASSIGNED])
    const field = await openReply(root)
    expect(replyButton(root).textContent?.trim()).toBe('Ada via Claude')
    expect(replyPicker(root, 'c-1').getAttribute('data-selected')).toBe(JSON.stringify(ADAS_AGENT))

    await setText(field, 'Agreed.')
    press(field, 'ctrlKey')

    expect(assigned).toEqual([])
    await sent()
    expect(replied).toEqual([{ blockId: 'b-1', threadId: 'c-1', text: 'Agreed.' }])
  })

  it('keeps the reply\'s selection on a Backspace inside a mention', async () => {
    const { root, assigned } = mount(CANDIDATES, [THREAD])
    const field = await openReply(root)
    await setText(field, 'over to @Ada via Claude ')
    nextPick = null
    replyPicker(root, 'c-1').click()
    await nextTick()

    await setText(field, 'over to @Ada via Claude')
    await setText(field, 'over to @Ada via Claud')

    expect(replyButton(root).getAttribute('aria-label')).toBe('Assignee: Nobody')
    press(field, 'ctrlKey')
    expect(assigned).toEqual([])
  })

  // The reader is no candidate of their own menu; it lists them all the same.
  it('names the reader on a reply to a thread assigned to them', async () => {
    const me = { uid: 3, name: 'Bob', via: null }
    const mine: CommentThreadView = { ...THREAD, assignee: me, assignedTo: [me] }
    const { root } = mount(CANDIDATES, [mine], null, { uid: 3, name: 'Bob' })
    await openReply(root)

    expect(replyButton(root).getAttribute('aria-label')).toBe('Assignee: Bob')
    expect(replyPicker(root, 'c-1').getAttribute('data-selected')).toBe(JSON.stringify(me))
  })

  it('keeps the thread\'s assignee in the reply\'s menu once Nobody is picked', async () => {
    const me = { uid: 3, name: 'Bob', via: null }
    const mine: CommentThreadView = { ...THREAD, assignee: me, assignedTo: [me] }
    const { root } = mount(CANDIDATES, [mine], null, { uid: 3, name: 'Bob' })
    await openReply(root)

    nextPick = null
    replyPicker(root, 'c-1').click()
    await nextTick()

    expect(replyButton(root).getAttribute('aria-label')).toBe('Assignee: Nobody')
    expect(replyPicker(root, 'c-1').getAttribute('data-assigned')).toBe(JSON.stringify(me))
  })

  it('marks the thread\'s assignee in the chip\'s menu', () => {
    const assignedThread: CommentThreadView = { ...THREAD, assignee: ADAS_AGENT, assignedTo: [ADAS_AGENT] }
    const { root } = mount(CANDIDATES, [assignedThread])

    expect(chipPicker(root).getAttribute('data-selected')).toBe(JSON.stringify(ADAS_AGENT))
  })

  it('writes nothing when the chip\'s menu picks the thread\'s assignee again', async () => {
    const assignedThread: CommentThreadView = { ...THREAD, assignee: ADAS_AGENT, assignedTo: [ADAS_AGENT] }
    const { root, assigned } = mount(CANDIDATES, [assignedThread])

    nextPick = ADAS_AGENT
    chipPicker(root).click()
    await nextTick()

    expect(assigned).toEqual([])
  })

  it('assigns nothing when a reply on an unassigned thread leaves the menu alone', async () => {
    const { root, replied, assigned } = mount(CANDIDATES, [THREAD])
    const field = await openReply(root)

    await setText(field, 'Agreed.')
    press(field, 'ctrlKey')

    expect(assigned).toEqual([])
    await sent()
    expect(replied).toEqual([{ blockId: 'b-1', threadId: 'c-1', text: 'Agreed.' }])
  })

  it('does not assign again when the pick is who holds the thread already', async () => {
    const { root, assigned } = mount(CANDIDATES, [ASSIGNED])
    const field = await openReply(root)

    replyPicker(root, 'c-1').click()
    await setText(field, 'Agreed.')
    press(field, 'ctrlKey')

    expect(assigned).toEqual([])
  })

  it('takes the thread off its assignee when the reply picks Nobody', async () => {
    const { root, assigned } = mount(CANDIDATES, [ASSIGNED])
    const field = await openReply(root)

    nextPick = null
    replyPicker(root, 'c-1').click()
    await setText(field, 'Mine after all.')
    press(field, 'ctrlKey')

    expect(assigned).toEqual([{ blockId: 'b-1', threadId: 'c-1', assignee: null }])
  })

  it('does not carry an open picker over to the next thread it is opened on', async () => {
    const other: CommentThreadView = { ...THREAD, threadId: 'c-2', blockText: 'Another passage' }
    const { root } = mount(CANDIDATES, [THREAD, other])
    const field = await openReply(root)
    field.value = '@'
    field.selectionStart = 1
    field.dispatchEvent(new (window as never as { InputEvent: typeof InputEvent }).InputEvent('input', {
      data: '@',
      bubbles: true,
    }))
    await nextTick()
    expect(replyPicker(root, 'c-1').getAttribute('data-open')).toBe('true')

    root.querySelector<HTMLElement>('[data-testid="comment-reply-c-2"]')!.click()
    await nextTick()

    expect(replyPicker(root, 'c-2').getAttribute('data-open')).toBe('false')
  })
})

describe('a message, read', () => {
  const said: CommentThreadView = {
    ...THREAD,
    messages: [{ id: 'm-a', uid: 7, name: 'Ada', via: null, at: AT, text: 'over to :mention[Claude]{uid="7" via="Claude"} now' }],
  }
  const body = (root: HTMLElement) => root.querySelector('[data-testid="comment-message-m-a"]')!

  it('draws a stored mention as the page body\'s chip, in the agent colour', async () => {
    const { root } = mount(CANDIDATES, [said], null, { uid: 7, name: 'Ada' })
    await drawn()

    expect(body(root).textContent).toBe('over to @Claude now')
    expect([...body(root).querySelectorAll('.mention')].map(chip => chip.textContent)).toEqual(['@Claude'])
    expect(body(root).querySelector('.mention')!.classList).toContain('mention--agent')
  })

  it('names a mentioned agent by its owner, except to the owner', async () => {
    const { root } = mount(CANDIDATES, [said], null, { uid: 3, name: 'Bob' })
    await drawn()

    expect(body(root).textContent).toBe('over to @Ada via Claude now')
  })

  it('names a mentioned account, and an author, as they are called now', async () => {
    currentNames.set(11, 'Grace')
    const renamed: CommentThreadView = {
      ...THREAD,
      messages: [{ id: 'm-a', uid: 11, name: 'grace-old', via: null, at: AT, text: 'ask :mention[grace-old]{uid="11"}' }],
    }
    const { root } = mount(CANDIDATES, [renamed], null, { uid: 3, name: 'Bob' })
    await drawn()

    expect(body(root).textContent).toBe('ask @Grace')
    expect(body(root).previousElementSibling!.querySelector('span')!.textContent).toBe('Grace')
  })

  it('reads a mention of an account it cannot name as plain text', async () => {
    const gone: CommentThreadView = {
      ...THREAD,
      messages: [{ id: 'm-a', uid: 7, name: 'Ada', via: null, at: AT, text: 'ask :mention[Admin]{uid="99"} or :mention[x]{uid="0"}' }],
    }
    const { root } = mount(CANDIDATES, [gone], null, { uid: 3, name: 'Bob' })
    await drawn()

    expect(body(root).textContent).toBe('ask @Admin or @x')
    expect(body(root).querySelector('.mention')).toBeNull()
  })

  it('names an agent\'s message by its owner, except to the owner', () => {
    const answered: CommentThreadView = {
      ...THREAD,
      messages: [{ id: 'm-a', uid: 7, name: 'Ada', via: 'Claude', at: AT, text: 'done' }],
    }
    const author = (root: HTMLElement) => body(root).previousElementSibling!.querySelector('span')!.textContent

    expect(author(mount(CANDIDATES, [answered], null, { uid: 7, name: 'Ada' }).root)).toBe('Claude')
    expect(author(mount(CANDIDATES, [answered], null, { uid: 3, name: 'Bob' }).root)).toBe('Ada via Claude')
  })
})

describe('posting with the keyboard', () => {
  /** Opens the reply box on the one thread and returns it. */
  async function replyBox(root: HTMLElement): Promise<HTMLTextAreaElement> {
    root.querySelector<HTMLElement>('[data-testid="comment-reply-c-1"]')!.click()
    await nextTick()
    const field = root.querySelector<HTMLTextAreaElement>(
      '[aria-label="Reply to the comment on The quick brown fox"]',
    )!
    field.value = 'Agreed.'
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    return field
  }

  it('sends a reply on Ctrl+Enter and leaves a bare Enter a newline', async () => {
    const { root, replied } = mount(CANDIDATES, [THREAD])
    const field = await replyBox(root)

    press(field, null)
    expect(replied).toEqual([])

    press(field, 'ctrlKey')
    await sent()
    expect(replied).toEqual([{ blockId: 'b-1', threadId: 'c-1', text: 'Agreed.' }])
  })

  it('takes Cmd+Enter too, which is the same press on macOS', async () => {
    const { root, replied } = mount(CANDIDATES, [THREAD])
    const field = await replyBox(root)

    press(field, 'metaKey')
    await sent()
    expect(replied).toEqual([{ blockId: 'b-1', threadId: 'c-1', text: 'Agreed.' }])
  })
})

/**
 * What the editor selects is what the drawer brings into view: a click on a
 * highlighted passage selects one comment, a margin badge selects a block.
 */
describe('the comment the drawer opens on', () => {
  const noScroll = Element.prototype.scrollIntoView
  afterEach(() => { Element.prototype.scrollIntoView = noScroll })

  /** Records which elements were scrolled into view, in order. */
  function watchScroll(): HTMLElement[] {
    const scrolled: HTMLElement[] = []
    Element.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) {
      scrolled.push(this)
    }
    return scrolled
  }

  const FIRST = { ...THREAD, threadId: 'c-1' }
  const SECOND = { ...THREAD, threadId: 'c-2', blockId: 'b-2' }

  it('brings the selected comment into view and outlines it', async () => {
    const scrolled = watchScroll()
    const { root } = mount(CANDIDATES, [FIRST, SECOND], { blockId: 'b-2', threadId: 'c-2', at: AT })
    await nextTick()

    expect(scrolled.map(el => el.getAttribute('data-comment-thread'))).toEqual(['c-2'])
    const selected = root.querySelector('[data-comment-thread="c-2"]')!
    expect(selected.className).toContain('border-primary')
    expect(root.querySelector('[data-comment-thread="c-1"]')!.className).not.toContain('border-primary')
  })

  it('brings the selected comment into view once the threads arrive', async () => {
    const scrolled = watchScroll()
    const threads = reactive<CommentThreadView[]>([])
    mount(CANDIDATES, threads, { blockId: 'b-2', threadId: 'c-2', at: AT })
    await nextTick()
    expect(scrolled).toEqual([])

    threads.push(FIRST, SECOND)
    await nextTick()

    expect(scrolled.map(el => el.getAttribute('data-comment-thread'))).toEqual(['c-2'])
  })

  it('brings the block into view when no single comment is selected', async () => {
    const scrolled = watchScroll()
    const { root } = mount(CANDIDATES, [FIRST, SECOND], { blockId: 'b-2', at: AT })
    await nextTick()

    expect(scrolled.map(el => el.getAttribute('data-comment-block'))).toEqual(['b-2'])
    // Nothing is outlined: the badge selected a block, not one comment.
    expect(root.querySelector('[data-comment-thread="c-2"]')!.className).not.toContain('border-primary')
  })
})
