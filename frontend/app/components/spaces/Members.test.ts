// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createApp, h } from 'vue'
import SpaceMembers from './Members.vue'
import type { KbSpaceDetail } from '#shared/utils/kb-spaces'

/**
 * The members form in a bare Vue app, Nuxt UI stubbed to plain elements.
 *
 * Asserted: the pending invites come from their own request when the form
 * mounts and after an invite or cancel, a failing one leaves the roster as
 * usable as before, a refused invite shows Drupal's sentence, and a roster
 * write keeps who joined since the form loaded.
 */

const SPACE: KbSpaceDetail = {
  id: 'space-uuid',
  internalId: 4,
  name: 'Engineering',
  slug: 'engineering',
  description: '',
  readAccess: 'members_only',
  moderation: false,
  agentReview: false,
  managers: [{ id: 'user-m', uid: 2, name: 'mia' }],
  members: [{ id: 'user-a', uid: 3, name: 'ada' }],
  viewers: [],
  canManage: true,
  canInvite: true,
}

const fetchMock = vi.fn()
const csrfFetchMock = vi.fn()

function element(tag: string) {
  return { setup: (_: unknown, { slots }: { slots: Record<string, (() => unknown) | undefined> }) => () => h(tag, slots.default?.()) }
}

function mount() {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp({ render: () => h(SpaceMembers, { space: SPACE }) })
  for (const name of ['UIcon', 'UAlert', 'UBadge', 'UInputMenu', 'USelect']) {
    app.component(name, element('span'))
  }
  app.component('UInput', {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    setup: (props: { modelValue?: string }, { emit }: { emit: (event: 'update:modelValue', value: string) => void }) => () =>
      h('input', { value: props.modelValue, onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLInputElement).value) }),
  })
  app.component('UButton', element('button'))
  app.mount(root)
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const flush = () => new Promise(resolve => setTimeout(resolve))

beforeEach(() => {
  document.body.innerHTML = ''
  fetchMock.mockReset()
  csrfFetchMock.mockReset().mockResolvedValue(SPACE)
  vi.stubGlobal('$fetch', fetchMock)
  vi.stubGlobal('csrfFetch', csrfFetchMock)
})

describe('SpaceMembers — invites', () => {
  it('lists the pending invites on mount; another manager\'s without the email', async () => {
    fetchMock.mockResolvedValue({ data: [
      { id: 'invite-1', attributes: { mail: 'grace@example.com', role: 'viewer' } },
      { id: 'invite-2', attributes: { role: 'member' } },
    ] })
    mount()
    await flush()
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/drupal/jsonapi/openkb_invite/openkb_invite?'), expect.anything())
    expect(byTestId('space-invite-pending-grace@example.com')?.textContent).toContain('Viewer')
    expect(byTestId('space-invite-pending-invite-2')?.textContent).toContain('Invited by another manager')
    expect(byTestId('space-member-grace')).toBeNull()
  })

  it('lists a sent invite as pending; the roster stays as it was', async () => {
    fetchMock.mockResolvedValueOnce({ data: [] })
    csrfFetchMock.mockResolvedValue({ data: { id: 'invite-3', attributes: { mail: 'eve@example.com', role: 'member' } } })
    mount()
    await flush()
    const email = byTestId('space-members-invite-email') as HTMLInputElement
    email.value = 'eve@example.com'
    email.dispatchEvent(new Event('input'))
    await flush()
    fetchMock.mockResolvedValueOnce({ data: [{ id: 'invite-3', attributes: { mail: 'eve@example.com', role: 'member' } }] })
    byTestId('space-members-invite')!.dispatchEvent(new Event('submit'))
    await flush()
    await flush()
    expect(byTestId('space-members-invite-notice')?.textContent?.trim()).toBe('Invitation sent to eve@example.com.')
    expect(byTestId('space-invite-pending-eve@example.com')).not.toBeNull()
    expect(fetchMock).not.toHaveBeenCalledWith('/api/spaces/engineering')
    expect(byTestId('space-members-count')?.textContent?.trim()).toBe('2')
  })

  it('keeps the roster usable when the listing fails', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/spaces/engineering') return SPACE
      throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
    })
    mount()
    await flush()
    expect(byTestId('space-member-ada')).not.toBeNull()
    expect(byTestId('space-members-pending')).toBeNull()
    expect(byTestId('space-members-error')).toBeNull()

    byTestId('space-member-remove-ada')!.click()
    await flush()
    expect(csrfFetchMock).toHaveBeenCalledWith('/api/spaces/engineering', expect.objectContaining({
      method: 'PATCH',
      body: { managers: ['user-m'], members: [], viewers: [] },
    }))
  })

  it('cancels a pending invite and lists the pending ones again', async () => {
    fetchMock.mockResolvedValueOnce({ data: [{ id: 'invite-1', attributes: { mail: 'grace@example.com', role: 'viewer' } }] })
    csrfFetchMock.mockResolvedValue(null)
    mount()
    await flush()
    fetchMock.mockResolvedValueOnce({ data: [] })
    byTestId('space-invite-cancel-grace@example.com')!.click()
    await flush()
    await flush()
    expect(csrfFetchMock).toHaveBeenCalledWith('/api/drupal/jsonapi/openkb_invite/openkb_invite/invite-1', expect.objectContaining({ method: 'DELETE' }))
    expect(byTestId('space-invite-pending-grace@example.com')).toBeNull()
    expect(byTestId('space-members-error')).toBeNull()
  })

  it('keeps a member who joined since the form loaded when writing the roster', async () => {
    const joined = { ...SPACE, members: [...SPACE.members, { id: 'user-g', uid: 5, name: 'grace' }] }
    fetchMock.mockImplementation(async (url: string) => (url === '/api/spaces/engineering' ? joined : { data: [] }))
    mount()
    await flush()
    byTestId('space-member-remove-ada')!.click()
    await flush()
    await flush()
    expect(csrfFetchMock).toHaveBeenCalledWith('/api/spaces/engineering', expect.objectContaining({
      method: 'PATCH',
      body: { managers: ['user-m'], members: ['user-g'], viewers: [] },
    }))
  })

  it('shows Drupal\'s sentence for a refused invite, without JSON:API\'s property path', async () => {
    fetchMock.mockResolvedValue({ data: [] })
    csrfFetchMock.mockRejectedValue(Object.assign(new Error('Unprocessable'), {
      statusCode: 422,
      data: { data: { violations: [{ detail: 'mail.0.value: This value is not a valid email address.' }] } },
    }))
    mount()
    await flush()
    const email = byTestId('space-members-invite-email') as HTMLInputElement
    email.value = 'ada@'
    email.dispatchEvent(new Event('input'))
    await flush()
    byTestId('space-members-invite')!.dispatchEvent(new Event('submit'))
    await flush()
    expect(csrfFetchMock).toHaveBeenCalledWith('/api/drupal/jsonapi/openkb_invite/openkb_invite', expect.anything())
    expect(byTestId('space-members-invite-error')?.textContent?.trim()).toBe('This value is not a valid email address.')
  })
})
