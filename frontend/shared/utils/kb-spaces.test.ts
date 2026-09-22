import { describe, expect, it } from 'vitest'
import { luminanceOf } from './presence'
import {
  canCreatePageIn,
  descriptionText,
  pageCountsBySpace,
  recentlyUpdated,
  spaceColor,
  spaceReviewSteps,
  type KbPageListItem,
  type KbSpaceCeProp,
} from './kb-spaces'

const eng = { id: 'uuid-eng', name: 'Engineering' }
const product = { id: 'uuid-prod', name: 'Product & Design' }

function page(title: string, space: KbPageListItem['space'], changed = 0): KbPageListItem {
  return { id: `uuid-${title}`, title, path: `/${title}`, space, changed }
}

/**
 * Hues no brand ramp carries, as `OFF_RAMP` in `brand-theme.spec.ts` sweeps
 * for them: violet, indigo, cobalt, rose and the off-ramp greens. Written out
 * here because that suite runs in a container the frontend is not mounted in.
 */
const RETIRED_ACCENTS = [
  '#7c3aed', '#8b5cf6', '#6d28d9', '#c4b5fd', '#a78bfa', '#f5f3ff',
  '#818cf8', '#6366f1', '#4f46e5', '#1e40af', '#93c5fd',
  '#e11d48', '#fb7185', '#be123c', '#15803d', '#4ade80',
]

describe('spaceColor', () => {
  it('is stable per space id', () => {
    expect(spaceColor(7)).toBe(spaceColor(7))
    expect(spaceColor(-7)).toBe(spaceColor(7))
  })

  it('carries a white initial at 4.5:1, every entry of the palette', () => {
    const colors = new Set<string>()
    for (let id = 0; id < 24; id++) {
      const color = spaceColor(id)
      colors.add(color)
      expect(1.05 / (luminanceOf(color) + 0.05)).toBeGreaterThanOrEqual(4.5)
    }
    expect(colors.size).toBe(6)
  })

  it('carries no retired accent', () => {
    for (let id = 0; id < 24; id++) {
      expect(RETIRED_ACCENTS).not.toContain(spaceColor(id))
    }
  })
})

describe('recentlyUpdated', () => {
  it('orders by last change, newest first, and caps the list', () => {
    const list = [
      page('old', eng, 1000),
      page('newest', eng, 3000),
      page('middle', product, 2000),
    ]
    expect(recentlyUpdated(list, 2).map(a => a.title)).toEqual(['newest', 'middle'])
  })

  it('sorts pages with no timestamp last', () => {
    const list = [page('unknown', eng, 0), page('known', eng, 500)]
    expect(recentlyUpdated(list, 5).map(a => a.title)).toEqual(['known', 'unknown'])
  })

  it('leaves the input array untouched', () => {
    const list = [page('a', eng, 1), page('b', eng, 2)]
    recentlyUpdated(list, 2)
    expect(list.map(a => a.title)).toEqual(['a', 'b'])
  })
})

describe('pageCountsBySpace', () => {
  it('counts pages per space and ignores the unassigned ones', () => {
    const counts = pageCountsBySpace([
      page('a', eng),
      page('b', eng),
      page('c', product),
      page('d', null),
    ])
    expect(counts.get(eng.id)).toBe(2)
    expect(counts.get(product.id)).toBe(1)
    expect(counts.size).toBe(2)
  })
})

describe('descriptionText', () => {
  it('flattens the space description markup to one line', () => {
    expect(descriptionText('<p>Runbooks &nbsp;and\n  ADRs.</p>')).toBe('Runbooks and ADRs.')
  })

  it('is empty for an empty description', () => {
    expect(descriptionText('')).toBe('')
  })
})

/**
 * The read page's copy of \Drupal\openkb_workflow\ReviewPolicy: which steps a
 * space enforces, derived from the two flags its CE payload carries. A reader
 * cannot fetch the moderation status, so this is the only answer they get.
 */
describe('spaceReviewSteps', () => {
  const space = (overrides: Partial<KbSpaceCeProp>): KbSpaceCeProp => ({
    uuid: 'u', id: 1, name: 'Space', path: '/space', readAccess: 'all_users', ...overrides,
  })

  it('runs both steps in a moderated space', () => {
    expect(spaceReviewSteps(space({ moderation: true, agentReview: true })))
      .toEqual(['agent', 'peer'])
  })

  it('runs the agent step in a wiki space — the one place unreviewed agent text would go live', () => {
    expect(spaceReviewSteps(space({ moderation: false, agentReview: true }))).toEqual(['agent'])
  })

  it('runs nothing where the space asks for nothing', () => {
    expect(spaceReviewSteps(space({ moderation: false, agentReview: false }))).toEqual([])
  })

  it('falls closed on a payload that carries no policy', () => {
    expect(spaceReviewSteps(null)).toEqual(['agent', 'peer'])
    expect(spaceReviewSteps(undefined)).toEqual(['agent', 'peer'])
    expect(spaceReviewSteps(space({ moderation: true }))).toEqual(['agent', 'peer'])
  })
})

describe('canCreatePageIn', () => {
  /**
   * The four seats OKB-203 names, as `/api/spaces` answers them: a reader of a
   * space carries `canWrite: false`, a member and a manager carry `true`.
   */
  const SPACES = [
    { slug: 'general', canWrite: false },
    { slug: 'team-wiki', canWrite: true },
  ]

  it('refuses anonymous, which holds neither half', () => {
    expect(canCreatePageIn([], null, false)).toBe(false)
    expect(canCreatePageIn(SPACES, 'team-wiki', false)).toBe(false)
  })

  it('refuses a reader of the space in context, who holds the site permission', () => {
    expect(canCreatePageIn(SPACES, 'general', true)).toBe(false)
  })

  it('allows a writer of the space in context', () => {
    expect(canCreatePageIn(SPACES, 'team-wiki', true)).toBe(true)
  })

  it('allows a manager, whose access already covers writing', () => {
    // The map ranks read < write < manage, so the server answers a manager
    // `canWrite: true` — there is no separate seat to decide here.
    expect(canCreatePageIn([{ slug: 'team-wiki', canWrite: true }], 'team-wiki', true)).toBe(true)
  })

  it('asks for any writable space where none is in context', () => {
    expect(canCreatePageIn(SPACES, null, true)).toBe(true)
    expect(canCreatePageIn([{ slug: 'general', canWrite: false }], null, true)).toBe(false)
    expect(canCreatePageIn([], null, true)).toBe(false)
  })

  it('falls closed on a space the listing does not carry, and on a missing flag', () => {
    // An access map that could not be read leaves the flag off entirely; that
    // is the same answer as "no", never "unknown, so draw it".
    expect(canCreatePageIn(SPACES, 'nowhere', true)).toBe(false)
    expect(canCreatePageIn([{ slug: 'team-wiki' }], 'team-wiki', true)).toBe(false)
    expect(canCreatePageIn([{ slug: 'team-wiki' }], null, true)).toBe(false)
  })
})
