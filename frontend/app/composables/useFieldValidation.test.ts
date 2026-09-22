import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { computed, ref } from 'vue'
import type { FrontmatterFormField } from '~/editor/frontmatter-model'
import { useFieldValidation } from './useFieldValidation'

/**
 * The dry-run validation lane (OKB-53): debounce, batching, per-key epochs,
 * name↔key translation, and the advisory-only failure posture.
 */

function formField(key: string, name: string): FrontmatterFormField {
  return {
    key,
    name,
    label: key,
    required: false,
    multiple: false,
    widget: 'text',
    options: [],
    reference: null,
  }
}

const MODEL = computed(() => [
  formField('summary', 'field_summary'),
  formField('owner', 'field_owner'),
])

function harness(overrides: {
  respond?: (fields: Record<string, unknown>) => Promise<{ errors?: Record<string, string[]> }>
} = {}) {
  const values = ref<Record<string, unknown>>({ title: 'T', summary: 'S', owner: null })
  const requests: Array<Record<string, unknown>> = []
  const respond = overrides.respond
    ?? (async () => ({ errors: {} }))
  const api = useFieldValidation({
    nid: ref(1),
    model: MODEL,
    values: () => ({ ...values.value }) as never,
    debounceMs: 1000,
    request: async (_nid, fields) => {
      requests.push(fields as Record<string, unknown>)
      return respond(fields as Record<string, unknown>)
    },
  })
  return { api, values, requests }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('useFieldValidation', () => {
  it('debounces: no request until the idle window elapses', async () => {
    const { api, requests } = harness()
    api.touch('summary')
    await vi.advanceTimersByTimeAsync(900)
    expect(requests).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(100)
    expect(requests).toHaveLength(1)
  })

  it('a touch inside the window restarts it and batches the keys into one request', async () => {
    const { api, values, requests } = harness()
    api.touch('summary')
    await vi.advanceTimersByTimeAsync(900)
    values.value.owner = { id: 'u1', label: 'Ada' }
    api.touch('owner')
    await vi.advanceTimersByTimeAsync(900)
    expect(requests).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(100)
    expect(requests).toHaveLength(1)
    // JSON:API field names carry the current session values.
    expect(requests[0]).toEqual({
      field_summary: 'S',
      field_owner: { id: 'u1', label: 'Ada' },
    })
  })

  it('feeds messages into liveErrors under the frontmatter key', async () => {
    const { api } = harness({
      respond: async () => ({ errors: { field_summary: ['Too long.'] } }),
    })
    api.touch('summary')
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.liveErrors.value).toEqual({ summary: ['Too long.'] })
  })

  it('validates the title (base field outside the model) under its own key', async () => {
    const { api, requests } = harness({
      respond: async () => ({ errors: { title: ['Required.'] } }),
    })
    api.touch('title')
    await vi.advanceTimersByTimeAsync(1000)
    expect(requests[0]).toEqual({ title: 'T' })
    expect(api.liveErrors.value).toEqual({ title: ['Required.'] })
  })

  it('a new touch clears the slot immediately and a clean run keeps it clear', async () => {
    const { api } = harness({
      respond: (() => {
        let first = true
        return async () => {
          if (first) {
            first = false
            return { errors: { field_summary: ['Bad.'] } }
          }
          return { errors: {} }
        }
      })(),
    })
    api.touch('summary')
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.liveErrors.value.summary).toEqual(['Bad.'])
    // Correction: slot clears on the touch, before any response.
    api.touch('summary')
    expect(api.liveErrors.value.summary).toEqual([])
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.liveErrors.value.summary).toEqual([])
  })

  it('an edited key still masks (empty entry) so a stale 422 loses its slot', async () => {
    const { api } = harness()
    api.touch('summary')
    expect(api.liveErrors.value).toEqual({ summary: [] })
  })

  it('drops a stale response for a key touched while the request was in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { api } = harness({
      respond: async () => {
        await gate
        return { errors: { field_summary: ['Stale message.'] } }
      },
    })
    api.touch('summary')
    await vi.advanceTimersByTimeAsync(1000)
    // Request in flight; the user keeps typing.
    api.touch('summary')
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.liveErrors.value.summary).toEqual([])
    // The rescheduled run owns the slot once its own response lands.
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.liveErrors.value.summary).toEqual(['Stale message.'])
  })

  it('a failed request surfaces nothing — the lane is advisory', async () => {
    const { api } = harness({
      respond: async () => { throw new Error('503') },
    })
    api.touch('summary')
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.liveErrors.value.summary).toEqual([])
  })

  it('reset drops shown and pending state', async () => {
    const { api, requests } = harness({
      respond: async () => ({ errors: { field_summary: ['Bad.'] } }),
    })
    api.touch('summary')
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.liveErrors.value.summary).toEqual(['Bad.'])
    api.touch('owner')
    api.reset()
    expect(api.liveErrors.value).toEqual({})
    await vi.advanceTimersByTimeAsync(2000)
    expect(requests).toHaveLength(1)
  })

  it('skips keys the model cannot address', async () => {
    const { api, requests } = harness()
    api.touch('mystery')
    await vi.advanceTimersByTimeAsync(1000)
    expect(requests).toHaveLength(0)
  })
})
