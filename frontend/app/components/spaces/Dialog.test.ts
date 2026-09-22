// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createApp, h, nextTick, ref, type Ref } from 'vue'
import SpaceDialog from './Dialog.vue'
import PolicyOptions from './PolicyOptions.vue'
import type { KbSpaceDetail } from '#shared/utils/kb-spaces'

/**
 * The space dialog in a bare Vue app, with Nuxt UI stubbed down to what the
 * form needs from it: a field wrapper, inputs that carry a value both ways and
 * buttons that click. The policy options are the real component — the choice
 * they render is what "prefilled" means here.
 *
 * Asserted is the difference between the two modes: what an edit prefills,
 * what it leaves out, and the request each mode sends.
 */

const SPACE: KbSpaceDetail = {
  id: 'space-uuid',
  internalId: 4,
  name: 'Engineering',
  slug: 'engineering',
  description: 'How we build things.',
  readAccess: 'all_users',
  moderation: false,
  agentReview: false,
  managers: [],
  members: [],
  viewers: [],
  canManage: true,
}

const fetchMock = vi.fn()
const toastMock = vi.fn()
/** What the dialog did, in order — closing and navigating are both effects. */
let effects: string[] = []

function passthrough(tag: string) {
  return { setup: (_: unknown, { slots }: { slots: Record<string, (() => unknown) | undefined> }) => () => h(tag, slots.default?.()) }
}

/** An input stub that reads and writes the model the way `v-model` expects. */
const inputStub = {
  props: ['modelValue'],
  emits: ['update:modelValue'],
  setup: (props: { modelValue?: string }, { emit }: { emit: (e: 'update:modelValue', v: string) => void }) => () =>
    h('input', {
      value: props.modelValue ?? '',
      onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value),
    }),
}

function mount(open: Ref<boolean>, space?: KbSpaceDetail) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp({
    render: () => h(SpaceDialog, {
      'open': open.value,
      'space': space,
      'onUpdate:open': (value: boolean) => {
        effects.push(value ? 'open' : 'close')
        open.value = value
      },
    }),
  })
  app.component('UModal', {
    props: ['open', 'title', 'description'],
    setup: (_: unknown, { slots }) => () => h('div', [slots.body?.(), slots.footer?.()]),
  })
  app.component('UFormField', passthrough('div'))
  app.component('UAlert', { props: ['description'], setup: (props: { description?: string }) => () => h('p', props.description) })
  app.component('UIcon', { props: ['name'], setup: () => () => h('span') })
  app.component('UInput', inputStub)
  app.component('UTextarea', inputStub)
  // `type` and `form` are what wires the footer's Save to the form in the body.
  app.component('UButton', {
    props: ['loading', 'disabled', 'icon', 'color', 'variant', 'size', 'type', 'form'],
    setup: (props: { disabled?: boolean, type?: string, form?: string }, { slots }) => () =>
      h('button', { type: props.type ?? 'button', form: props.form, disabled: props.disabled }, slots.default?.()),
  })
  app.component('SpacePolicyOptions', PolicyOptions)
  // The real one is a Reka switch: a button with `role="switch"` that flips
  // the model on click.
  app.component('USwitch', {
    props: ['modelValue', 'label', 'description', 'disabled'],
    emits: ['update:modelValue'],
    setup: (props: { modelValue?: boolean, label?: string, description?: string, disabled?: boolean }, { emit, attrs }) => () =>
      h('button', {
        'type': 'button',
        'role': 'switch',
        'aria-checked': String(!!props.modelValue),
        'data-testid': attrs['data-testid'],
        'disabled': props.disabled,
        'onClick': () => emit('update:modelValue', !props.modelValue),
      }, [h('span', props.label), h('span', props.description)]),
  })
  app.component('SpaceMembers', { props: ['space'], setup: () => () => h('div', { 'data-testid': 'space-members-stub' }) })
  app.mount(root)
  return root
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const pressed = (id: string) => byTestId(id)?.getAttribute('aria-pressed')
const checked = (id: string) => byTestId(id)?.getAttribute('aria-checked')
const hintOf = (id: string) => byTestId(id)?.lastElementChild?.textContent

function type(id: string, value: string) {
  const input = byTestId(id) as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input'))
}

/** Lets the submit's promise chain and the render it causes run out. */
const flush = () => new Promise(resolve => setTimeout(resolve))

/** Opens the dialog, which is what fills the form. */
async function open(space?: KbSpaceDetail) {
  const isOpen = ref(false)
  mount(isOpen, space)
  isOpen.value = true
  await nextTick()
  await nextTick()
  return isOpen
}

beforeEach(() => {
  document.body.innerHTML = ''
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(SPACE)
  vi.stubGlobal('$fetch', fetchMock)
  effects = []
  vi.stubGlobal('navigateTo', vi.fn(() => effects.push('navigate')))
  vi.stubGlobal('refreshNuxtData', vi.fn())
  toastMock.mockReset()
  vi.stubGlobal('useToast', () => ({ add: toastMock }))
})

describe('SpaceDialog — editing a space', () => {
  it('prefills the description and both policies from the space', async () => {
    await open(SPACE)

    expect((byTestId('space-settings-description') as HTMLInputElement).value).toBe('How we build things.')
    expect(pressed('space-settings-read-access-all_users')).toBe('true')
    expect(pressed('space-settings-read-access-members_only')).toBe('false')
    expect(checked('space-settings-moderation')).toBe('false')
    expect(checked('space-settings-agent-review')).toBe('false')
    // The hint explains the state the switch is in.
    expect(hintOf('space-settings-agent-review')).toContain('publish like human edits')
  })

  it('leaves the name out and carries the roster instead', async () => {
    await open(SPACE)

    expect(byTestId('new-space-name')).toBeNull()
    expect(byTestId('space-members-stub')).not.toBeNull()
    // The roster brings its own form, so it sits beside this one, not in it.
    expect(byTestId('space-settings-form')!.querySelector('[data-testid="space-members-stub"]')).toBeNull()
  })

  it('PATCHes the space with the description and the policies', async () => {
    const isOpen = await open(SPACE)

    type('space-settings-description', 'What we build, and why.')
    byTestId('space-settings-read-access-members_only')?.click()
    byTestId('space-settings-moderation')?.click()
    byTestId('space-settings-agent-review')?.click()
    await nextTick()
    expect(checked('space-settings-agent-review')).toBe('true')
    expect(hintOf('space-settings-agent-review')).toContain('waits for a person')
    byTestId('space-settings-submit')?.click()
    await flush()

    expect(fetchMock).toHaveBeenCalledWith('/api/spaces/engineering', {
      method: 'PATCH',
      body: {
        description: 'What we build, and why.',
        readAccess: 'members_only',
        moderation: true,
        agentReview: true,
      },
    })
    expect(isOpen.value).toBe(false)
  })

  it('sends only the field the author moved', async () => {
    await open(SPACE)

    type('space-settings-description', 'What we build, and why.')
    await nextTick()
    byTestId('space-settings-submit')?.click()
    await flush()

    expect(fetchMock).toHaveBeenCalledWith('/api/spaces/engineering', {
      method: 'PATCH',
      body: { description: 'What we build, and why.' },
    })
  })

  it('writes nothing when the author changed nothing', async () => {
    const isOpen = await open(SPACE)

    byTestId('space-settings-submit')?.click()
    await flush()

    // A whole write would put the untouched fields back over another
    // manager's edit.
    expect(fetchMock).not.toHaveBeenCalled()
    expect(isOpen.value).toBe(false)
  })
})

describe('SpaceDialog — creating a space', () => {
  it('asks for the name and POSTs the new space', async () => {
    fetchMock.mockResolvedValue({ id: 'new-uuid', slug: 'research' })
    await open()

    expect(byTestId('new-space-name')).not.toBeNull()
    expect(byTestId('space-members-stub')).toBeNull()
    expect(pressed('new-space-read-access-members_only')).toBe('true')
    expect(checked('new-space-moderation')).toBe('true')
    expect(checked('new-space-agent-review')).toBe('true')

    type('new-space-name', 'Research')
    await nextTick()
    byTestId('new-space-submit')?.click()
    await flush()

    // Closed on the space being created, not on the navigation after it: the
    // modal is never up over the new space's own page.
    expect(effects).toEqual(['close', 'navigate'])

    expect(fetchMock).toHaveBeenCalledWith('/api/spaces', {
      method: 'POST',
      body: {
        name: 'Research',
        description: undefined,
        readAccess: 'members_only',
        moderation: true,
        agentReview: true,
      },
    })
  })

  it('takes the agent flag off and POSTs it as the choice it is', async () => {
    fetchMock.mockResolvedValue({ id: 'new-uuid', slug: 'research' })
    await open()

    type('new-space-name', 'Research')
    byTestId('new-space-agent-review')?.click()
    await nextTick()
    byTestId('new-space-submit')?.click()
    await flush()

    expect(fetchMock).toHaveBeenCalledWith('/api/spaces', {
      method: 'POST',
      body: expect.objectContaining({ agentReview: false }),
    })
  })

  it('reports a failed navigation in a toast, because the dialog is already gone', async () => {
    fetchMock.mockResolvedValue({ id: 'new-uuid', slug: 'research' })
    vi.stubGlobal('navigateTo', vi.fn(() => {
      effects.push('navigate')
      throw new Error('route not found')
    }))
    await open()

    type('new-space-name', 'Research')
    await nextTick()
    byTestId('new-space-submit')?.click()
    await flush()

    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      title: 'The space was created, but opening it failed. Reload to see it.',
      color: 'error',
    }))
    // Not the in-dialog alert: it would render behind a closed modal, and it
    // would call a created space uncreated.
    expect(byTestId('new-space-error')).toBeNull()
  })
})
