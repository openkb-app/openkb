import { describe, it, expect } from 'vitest'
import { rowLink, rowExcerptParts, excerptParts, subSections, sectionLabel, sectionsLabel, changedOn } from './kb-search'
import type { SearchPage, SearchSection } from './kb-search'

function section(overrides: Partial<SearchSection> = {}): SearchSection {
  return {
    blockId: 'b-4',
    headingPath: ['Rotation notes', 'On call'],
    excerpt: 'Who carries the pager.',
    highlights: [],
    score: 0.91,
    path: '/team-wiki/rotation-notes#b-4',
    ...overrides,
  }
}

function page(sections: SearchSection[]): SearchPage {
  return {
    id: 'entity:node/7:en',
    score: sections[0]?.score ?? 0,
    title: 'Rotation notes',
    path: '/team-wiki/rotation-notes',
    space: 'Team Wiki',
    changed: 1758240000,
    sections,
  }
}

describe('search result rows', () => {
  it('opens the row on the section that matched best', () => {
    const row = page([section(), section({ blockId: 'b-9', path: '/team-wiki/rotation-notes#b-9' })])
    expect(rowLink(row)).toBe('/team-wiki/rotation-notes#b-4')
    expect(rowExcerptParts(row)).toEqual([{ text: 'Who carries the pager.', marked: false }])
  })

  it('links a page with nothing matched to itself', () => {
    const row = page([])
    expect(rowLink(row)).toBe('/team-wiki/rotation-notes')
    expect(rowExcerptParts(row)).toEqual([])
  })

  it('links a section whose markdown spells no block id to the page', () => {
    const row = page([section({ blockId: '', path: '/team-wiki/rotation-notes' })])
    expect(rowLink(row)).toBe('/team-wiki/rotation-notes')
  })

  it('lists every section but the one already shown as the excerpt', () => {
    const second = section({ blockId: 'b-9', headingPath: ['Rotation notes', 'Handover'] })
    expect(subSections(page([section(), second]))).toEqual([second])
    expect(subSections(page([section()]))).toEqual([])
  })

  it('names a sub-link by its own heading, and a lead section for what it is', () => {
    const row = page([])
    expect(sectionLabel(section({ headingPath: ['Rotation notes', 'Handover'] }), row)).toBe('Handover')
    // The lead section sits under no heading of its own, and the row already
    // carries the page title one line above it.
    expect(sectionLabel(section({ headingPath: [] }), row)).toBe('Introduction')
    // The chunker opens that path on the page's own `<h1>`, so the lead's path
    // is the row's title — which is the same lead, not a section named after it.
    expect(sectionLabel(section({ headingPath: ['Rotation notes'] }), row)).toBe('Introduction')
    // A heading inside the page that repeats the title is still a section.
    expect(sectionLabel(section({ headingPath: ['Rotation notes', 'Rotation notes'] }), row))
      .toBe('Rotation notes')
  })

  it('counts the sections listed under the label, not the excerpt’s', () => {
    expect(sectionsLabel(page([section(), section()]))).toBe('1 more matching section')
    expect(sectionsLabel(page([section(), section(), section()]))).toBe('2 more matching sections')
  })

  it('shows a change date only where the row carries one', () => {
    expect(changedOn(page([section()]))).toContain('2025')
    expect(changedOn({ ...page([section()]), changed: 0 })).toBe('')
  })

  it('marks the words the query matched, and nothing else', () => {
    const marked = section({ highlights: ['Who carries the \uE000pager\uE001 at night.'] })
    expect(excerptParts(marked)).toEqual([
      { text: 'Who carries the ', marked: false },
      { text: 'pager', marked: true },
      { text: ' at night.', marked: false },
    ])
  })

  it('reads a section found by meaning alone as its own plain text', () => {
    expect(excerptParts(section())).toEqual([{ text: 'Who carries the pager.', marked: false }])
  })

  it('leaves a tag the page text itself carries as text', () => {
    const marked = section({ highlights: ['Write <em>tag</em> for \uE000emphasis\uE001.'] })
    expect(excerptParts(marked)).toEqual([
      { text: 'Write <em>tag</em> for ', marked: false },
      { text: 'emphasis', marked: true },
      { text: '.', marked: false },
    ])
  })

  it('drops a mark character the fragment carries without its partner', () => {
    const marked = section({ highlights: ['Who carries the \uE000pager\uE001 at \uE000night.'] })
    expect(excerptParts(marked)).toEqual([
      { text: 'Who carries the ', marked: false },
      { text: 'pager', marked: true },
      { text: ' at night.', marked: false },
    ])
  })
})
