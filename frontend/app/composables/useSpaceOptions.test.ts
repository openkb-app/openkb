import { describe, it, expect, vi, afterEach } from 'vitest'
import { ref } from 'vue'
import { useSpaceOptions, type SpaceOption } from './useSpaceOptions'

/**
 * The list both placement dialogs choose from.
 *
 * Placing a page is `field_space` edit access, so a space the session may
 * only read is a refusal waiting to happen — it must never reach the picker.
 * The composable reaches for Nuxt's auto-imports, stubbed here with the
 * smallest things that behave like them.
 */

function stubNuxt(listed: SpaceOption[] | Error) {
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('console', { ...console, error: () => {} })
  vi.stubGlobal('$fetch', async () => {
    if (listed instanceof Error) throw listed
    return listed
  })
}

function space(slug: string, canWrite?: boolean): SpaceOption {
  return { id: `uuid-${slug}`, internalId: 1, name: slug, slug, description: '', canWrite }
}

describe('useSpaceOptions', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('offers the spaces the session may write and drops the ones it may only read', async () => {
    stubNuxt([space('general', false), space('team-wiki', true), space('handbook', true)])
    const { load, spaces } = useSpaceOptions()
    expect((await load()).map(s => s.slug)).toEqual(['team-wiki', 'handbook'])
    expect(spaces.value.map(s => s.slug)).toEqual(['team-wiki', 'handbook'])
  })

  it('drops a space whose access could not be answered at all', async () => {
    // A map that did not arrive leaves the flag off; that is "no", not "unknown".
    stubNuxt([space('general')])
    const { load } = useSpaceOptions()
    expect(await load()).toEqual([])
  })

  it('reports a failed listing instead of an empty one', async () => {
    stubNuxt(new Error('upstream'))
    const { load, failed } = useSpaceOptions()
    expect(await load()).toEqual([])
    expect(failed.value).toBe(true)
  })
})
