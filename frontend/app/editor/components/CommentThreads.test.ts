// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import CommentThreads from './CommentThreads.vue'
import type { CommentThreadView, ShownThreads } from '../comment-marks'
import { assigneeCandidates } from '../comment-assignee'
import type { PresencePeer } from '#shared/utils/presence'

/**
 * The composer half of the drawer, in a bare Vue app.
 *
 * Nuxt UI is stubbed down to what the component drives: a real `<textarea>` and
 * a picker that hands back the identity it was told to. The mention field is
 * the real one, so the echo behind the text is asserted here too.
 */

interface PickerProps { candidates: unknown[], open?: boolean }

function mount(
  candidates: ReturnType<typeof assigneeCandidates>,
  threads: CommentThreadView[] = [],
  shownFor: ShownThreads | null = null,
  me: { uid: number, name: string } | null = null,
) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const posted: unknown[] = []
  const replied: unknown[] = []
  const assigned: unknown[] = []
  const app = createApp({
    render: () => h(CommentThreads as never, {
      threads,
      draft: { blockId: 'b-1', anchor: null },
      shownFor,
      candidates,
      me,
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
    props: ['candidates', 'open', 'allowUnassign'],
    emits: ['pick', 'update:open'],
    setup: (props: PickerProps, { slots, emit }) => () => h('div', {
      'data-stub': 'picker',
      'data-open': String(!!props.open),
      'onClick': () => emit('pick', { uid: 7, name: 'Ada', via: 'Claude' }),
    }, slots.default?.()),
  })
  app.component('EditorAssigneeChip', { props: ['assignee', 'viewerUid'], render: () => h('span') })
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

const picker = (root: HTMLElement) => root.querySelector('[data-stub="picker"]')!
const replyPicker = (root: HTMLElement, threadId: string) => root
  .querySelector(`[data-testid="comment-reply-mention-${threadId}"]`)!
  .closest('[data-stub="picker"]')!
const assignNote = (root: HTMLElement) => root.querySelector('[data-testid="comment-assign-note"]')
/** The chips the echo paints behind the draft, in order. */
const echoed = (root: HTMLElement) => [...root.querySelectorAll('[data-testid="mention-echo"] .okb-mention-echo')]
  .map(chip => chip.textContent)

describe('the comment composer', () => {
  it('opens the picker on the @ that has already landed in the draft', async () => {
    const { root } = mount(CANDIDATES)

    expect(picker(root).getAttribute('data-open')).toBe('false')
    const field = await type(root, '@')

    expect(picker(root).getAttribute('data-open')).toBe('true')
    // The character stays where it was typed; the palette opens over a draft
    // that already holds it, never instead of it.
    expect(field.value).toBe('@')
  })

  it('writes the pick into the draft and says who it hands the thread to', async () => {
    const { root } = mount(CANDIDATES)
    await type(root, '@')

    ;(picker(root) as HTMLElement).click()
    await nextTick()

    // Somebody else's agent is named by its owner too.
    expect(root.querySelector<HTMLTextAreaElement>('[data-stub="textarea"]')!.value).toBe('@Ada via Claude ')
    expect(assignNote(root)?.textContent?.trim()).toBe('Assigns this to Ada via Claude')
  })

  it('names the reader\'s own agent by itself', async () => {
    const { root } = mount(CANDIDATES, [], null, { uid: 7, name: 'Ada' })
    await type(root, '@')

    ;(picker(root) as HTMLElement).click()
    await nextTick()

    expect(root.querySelector<HTMLTextAreaElement>('[data-stub="textarea"]')!.value).toBe('@Claude ')
    expect(assignNote(root)?.textContent?.trim()).toBe('Assigns this to Claude')
  })

  it('sets the mention off from the prose around it', async () => {
    const { root } = mount(CANDIDATES)
    await type(root, '@')

    ;(picker(root) as HTMLElement).click()
    await nextTick()

    expect(echoed(root)).toEqual(['@Ada via Claude'])
  })

  it('offers nothing to assign while the draft mentions nobody', async () => {
    const { root } = mount(CANDIDATES)
    await type(root, 'x')

    expect(picker(root).getAttribute('data-open')).toBe('false')
    expect(assignNote(root)).toBeNull()
    expect(echoed(root)).toEqual([])
  })

  it('posts the mention as the thread\'s assignee, with no box to tick', async () => {
    const { root, posted } = mount(CANDIDATES)
    await type(root, '@')

    ;(picker(root) as HTMLElement).click()
    await nextTick()
    root.querySelector<HTMLElement>('[data-testid="comment-post"]')!.click()

    expect(posted).toEqual([{
      text: '@Ada via Claude ',
      assignee: { uid: 7, name: 'Ada', via: 'Claude' },
    }])
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

  it('assigns the thread, not the reply, to whoever the reply mentions', async () => {
    const { root, replied, assigned } = mount(CANDIDATES, [THREAD])
    const field = await openReply(root)

    root.querySelector<HTMLElement>('[data-testid="comment-reply-mention-c-1"]')!
      .closest('[data-stub="picker"]')!.dispatchEvent(new Event('click', { bubbles: true }))
    await nextTick()

    expect(field.value).toBe('@Ada via Claude ')
    press(field, 'ctrlKey')

    expect(assigned).toEqual([{
      blockId: 'b-1',
      threadId: 'c-1',
      assignee: { uid: 7, name: 'Ada', via: 'Claude' },
    }])
    expect(replied).toEqual([{ blockId: 'b-1', threadId: 'c-1', text: '@Ada via Claude ' }])
  })

  it('leaves the thread where it is when the reply mentions nobody', async () => {
    const { root, replied, assigned } = mount(CANDIDATES, [THREAD])
    const field = await openReply(root)
    field.value = 'Agreed.'
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()

    press(field, 'ctrlKey')

    expect(assigned).toEqual([])
    expect(replied).toEqual([{ blockId: 'b-1', threadId: 'c-1', text: 'Agreed.' }])
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
    messages: [{ id: 'm-a', uid: 7, name: 'Ada', via: null, at: AT, text: 'over to @Claude now' }],
  }
  const body = (root: HTMLElement) => root.querySelector('[data-testid="comment-message-m-a"]')!

  it('names a mentioned agent the way the chips around it do', async () => {
    const { root } = mount(CANDIDATES, [said], null, { uid: 7, name: 'Ada' })
    expect(body(root).textContent).toBe('over to @Claude now')

    const { root: theirs } = mount(CANDIDATES, [said], null, { uid: 3, name: 'Bob' })
    expect(body(theirs).textContent).toBe('over to @Ada via Claude now')
  })

  it('names an agent it cannot be handed to, off the thread it is on', () => {
    // A reader with no agent of their own: nobody else's is in their picker.
    const others = assigneeCandidates([peer(1, 'Bob', 3)], [])
    const agent = { uid: 7, name: 'Ada', via: 'Claude' }
    const handed: CommentThreadView = { ...said, assignee: agent, assignedTo: [agent] }
    const { root } = mount(others, [handed], null, { uid: 3, name: 'Bob' })

    expect(body(root).textContent).toBe('over to @Ada via Claude now')
  })

  it('keeps naming it after the thread has moved on to somebody else', () => {
    const others = assigneeCandidates([peer(1, 'Bob', 3)], [])
    const agent = { uid: 7, name: 'Ada', via: 'Claude' }
    const bob = { uid: 3, name: 'Bob', via: null }
    const moved: CommentThreadView = { ...said, assignee: bob, assignedTo: [agent, bob] }
    const { root } = mount(others, [moved], null, { uid: 3, name: 'Bob' })

    expect(body(root).textContent).toBe('over to @Ada via Claude now')
  })

  it('sets the mention off as one, in the agent colour', () => {
    const { root } = mount(CANDIDATES, [said], null, { uid: 7, name: 'Ada' })

    expect([...body(root).querySelectorAll('.mention')].map(chip => chip.textContent))
      .toEqual(['@Claude'])
    expect(body(root).querySelector('.mention')!.classList).toContain('mention--agent')
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
    expect(replied).toEqual([{ blockId: 'b-1', threadId: 'c-1', text: 'Agreed.' }])
  })

  it('takes Cmd+Enter too, which is the same press on macOS', async () => {
    const { root, replied } = mount(CANDIDATES, [THREAD])
    const field = await replyBox(root)

    press(field, 'metaKey')
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

  it('brings the block into view when no single comment is selected', async () => {
    const scrolled = watchScroll()
    const { root } = mount(CANDIDATES, [FIRST, SECOND], { blockId: 'b-2', at: AT })
    await nextTick()

    expect(scrolled.map(el => el.getAttribute('data-comment-block'))).toEqual(['b-2'])
    // Nothing is outlined: the badge selected a block, not one comment.
    expect(root.querySelector('[data-comment-thread="c-2"]')!.className).not.toContain('border-primary')
  })
})
