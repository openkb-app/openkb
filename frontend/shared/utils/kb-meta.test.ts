import { describe, expect, it } from 'vitest'
import {
  absoluteDate,
  changedToMs,
  docTypeLabel,
  lastUpdatedLabel,
  ownerInitials,
  referenceLabels,
} from './kb-meta'

describe('docTypeLabel', () => {
  it('labels the allowed field_type values', () => {
    expect(docTypeLabel('article')).toBe('Article')
    expect(docTypeLabel('adr')).toBe('ADR')
    expect(docTypeLabel('runbook')).toBe('Runbook')
  })

  it('capitalises a value the frontend does not know yet', () => {
    expect(docTypeLabel('policy')).toBe('Policy')
  })

  it('has no label for a missing value — the pill must not invent one', () => {
    expect(docTypeLabel(undefined)).toBeNull()
    expect(docTypeLabel('')).toBeNull()
  })
})

describe('referenceLabels', () => {
  it('reads the label of each reference item, in field order', () => {
    expect(referenceLabels([
      { uuid: 't-24', label: 'platform' },
      { uuid: 't-25', label: 'search' },
    ])).toEqual(['platform', 'search'])
  })

  it('reads a single-value reference, which ships one object rather than a list', () => {
    expect(referenceLabels({ uuid: 'u-1', label: 'marta' })).toEqual(['marta'])
  })

  it('drops items whose entity the session may not view', () => {
    expect(referenceLabels([
      { uuid: 't-1' },
      { uuid: 't-2', label: '  ' },
      { uuid: 't-3', label: 'visible' },
    ])).toEqual(['visible'])
  })

  it('answers empty for an absent field', () => {
    expect(referenceLabels(undefined)).toEqual([])
    expect(referenceLabels(null)).toEqual([])
  })
})

describe('changedToMs', () => {
  it('converts Drupal epoch seconds to milliseconds', () => {
    expect(changedToMs('1785077569')).toBe(1785077569000)
    expect(changedToMs(1785077569)).toBe(1785077569000)
  })

  it('rejects what cannot be a timestamp', () => {
    expect(changedToMs(undefined)).toBeNull()
    expect(changedToMs('')).toBeNull()
    expect(changedToMs('not-a-number')).toBeNull()
    expect(changedToMs(0)).toBeNull()
  })
})

describe('lastUpdatedLabel', () => {
  const now = 1785077569000

  it('buckets from minutes up to months', () => {
    expect(lastUpdatedLabel(now - 30_000, now)).toBe('just now')
    expect(lastUpdatedLabel(now - 5 * 60_000, now)).toBe('5 minutes ago')
    expect(lastUpdatedLabel(now - 3 * 3_600_000, now)).toBe('3 hours ago')
    expect(lastUpdatedLabel(now - 2 * 86_400_000, now)).toBe('2 days ago')
    expect(lastUpdatedLabel(now - 3 * 7 * 86_400_000, now)).toBe('3 weeks ago')
    expect(lastUpdatedLabel(now - 200 * 86_400_000, now)).toBe('6 months ago')
  })

  it('reads a clock that runs behind as "just now" rather than the future', () => {
    expect(lastUpdatedLabel(now + 60_000, now)).toBe('just now')
  })

  it('has no label without a timestamp', () => {
    expect(lastUpdatedLabel(null, now)).toBeNull()
  })
})

describe('absoluteDate', () => {
  it('renders the ISO date for the tooltip', () => {
    expect(absoluteDate(1785077569000)).toBe('2026-07-26')
    expect(absoluteDate(null)).toBeNull()
  })
})

describe('ownerInitials', () => {
  it('takes first and last initial of a display name', () => {
    expect(ownerInitials('Marta Vogel')).toBe('MV')
    expect(ownerInitials('Ada B. Lovelace')).toBe('AL')
  })

  it('takes two characters of a single-word username', () => {
    expect(ownerInitials('admin')).toBe('AD')
  })

  it('is empty for no name', () => {
    expect(ownerInitials(undefined)).toBe('')
    expect(ownerInitials('   ')).toBe('')
  })
})
