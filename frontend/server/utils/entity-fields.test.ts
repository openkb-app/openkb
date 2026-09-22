import { describe, it, expect } from 'vitest'
import {
  changedFieldKeys,
  fieldSpecs,
  fieldValuesEqual,
  mapCeFieldValues,
  TITLE_KEY,
  type FieldSpec,
} from './entity-fields'

/** The published schema for the v1 field set, trimmed to what the mapper reads. */
const SCHEMA = {
  properties: {
    type: { type: 'string', enum: ['article', 'adr'], 'x-field-name': 'field_type' },
    summary: { type: 'string', 'x-field-name': 'field_summary' },
    owner: {
      type: 'object',
      'x-entity-reference': { entity_type: 'user' },
      'x-field-name': 'field_owner',
    },
    contributors: {
      type: 'array',
      items: { type: 'object', 'x-entity-reference': { entity_type: 'user' } },
      'x-field-name': 'field_contributors',
    },
    tags: {
      type: 'array',
      items: {
        type: 'object',
        'x-entity-reference': { entity_type: 'taxonomy_term', bundles: ['kb_tags'] },
      },
      'x-field-name': 'field_tags',
    },
  },
}

const SPECS = fieldSpecs(SCHEMA)

describe('fieldSpecs', () => {
  it('derives key, machine name, cardinality and reference target from the schema', () => {
    expect(SPECS).toEqual<FieldSpec[]>([
      { key: 'type', name: 'field_type', multiple: false, reference: false },
      { key: 'summary', name: 'field_summary', multiple: false, reference: false },
      { key: 'owner', name: 'field_owner', multiple: false, reference: true, entityType: 'user', bundles: [] },
      { key: 'contributors', name: 'field_contributors', multiple: true, reference: true, entityType: 'user', bundles: [] },
      { key: 'tags', name: 'field_tags', multiple: true, reference: true, entityType: 'taxonomy_term', bundles: ['kb_tags'] },
    ])
  })

  it('follows the exposure contract — an unplaced field has no spec', () => {
    const withoutTags = { properties: { ...SCHEMA.properties, tags: undefined } as never }
    expect(fieldSpecs(withoutTags).map(s => s.key)).not.toContain('tags')
  })

  it('skips a property with no machine name rather than guessing one', () => {
    const specs = fieldSpecs({ properties: { orphan: { type: 'string' } } })
    expect(specs).toEqual([])
  })

  it('survives an unreachable schema', () => {
    expect(fieldSpecs(null)).toEqual([])
  })
})

describe('mapCeFieldValues', () => {
  it('reads every exposed field off the CE props, references as {id, label}', () => {
    const values = mapCeFieldValues(SPECS, {
      title: 'Getting started',
      type: 'adr',
      summary: 'An abstract.',
      owner: { uuid: 'u-marta', label: 'Marta Vogel' },
      contributors: [{ uuid: 'u-jon', label: 'Jon' }],
      tags: [{ uuid: 't-1', label: 'platform' }, { uuid: 't-2', label: 'search' }],
    })

    expect(values).toEqual({
      [TITLE_KEY]: 'Getting started',
      type: 'adr',
      summary: 'An abstract.',
      owner: { id: 'u-marta', label: 'Marta Vogel' },
      contributors: [{ id: 'u-jon', label: 'Jon' }],
      tags: [{ id: 't-1', label: 'platform' }, { id: 't-2', label: 'search' }],
    })
  })

  it('reads an empty or unreadable field — which ships no prop at all — as null/[]', () => {
    expect(mapCeFieldValues(SPECS, { title: 'T' })).toEqual({
      [TITLE_KEY]: 'T',
      type: null,
      summary: null,
      owner: null,
      contributors: [],
      tags: [],
    })
  })
})

describe('field comparison', () => {
  const baseline = { title: 'T', summary: 'a', tags: [{ id: 'u1', label: 'search' }] }

  it('treats an identical payload as unchanged', () => {
    expect(fieldValuesEqual(baseline, { ...baseline })).toBe(true)
    expect(changedFieldKeys(baseline, { ...baseline })).toEqual([])
  })

  it('names the keys that moved', () => {
    const moved = { ...baseline, summary: 'b', title: 'T2' }
    expect(fieldValuesEqual(baseline, moved)).toBe(false)
    expect(changedFieldKeys(baseline, moved)).toEqual(['summary', 'title'])
  })

  it('counts a reordered multi-value field as changed — delta order is data', () => {
    const two = { tags: [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }] }
    const reordered = { tags: [{ id: 'b', label: 'b' }, { id: 'a', label: 'a' }] }
    expect(changedFieldKeys(two, reordered)).toEqual(['tags'])
  })

  it('counts a key present on one side only', () => {
    expect(changedFieldKeys(baseline, { title: 'T' })).toEqual(['summary', 'tags'])
  })
})
