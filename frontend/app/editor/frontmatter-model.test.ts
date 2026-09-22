import { describe, it, expect } from 'vitest'
import { toFormModel, type FrontmatterSchema } from './frontmatter-model'

/**
 * A schema shaped exactly like `GET /openkb/schema` for the v1 field set
 * (see recipes/openkb_recipe_core): field_type (enum, required), field_summary
 * (string_long textarea), field_owner (single user ref), field_contributors
 * (multi user ref), field_tags (multi term ref). Property order is the
 * form-display weight order the backend emits.
 */
const SCHEMA: FrontmatterSchema = {
  properties: {
    type: {
      type: 'string',
      enum: ['article', 'adr', 'guide', 'runbook'],
      'x-enum-labels': { article: 'Article', adr: 'ADR', guide: 'Guide', runbook: 'Runbook' },
      title: 'Type',
      description: 'Document type.',
      'x-widget': { type: 'options_select', settings: {} },
      'x-field-name': 'field_type',
    },
    summary: {
      type: 'string',
      title: 'Summary',
      description: 'One-paragraph abstract shown in listings and search results.',
      'x-widget': { type: 'string_textarea', settings: { rows: 3, placeholder: 'One-paragraph abstract for listings and search.' } },
      'x-field-name': 'field_summary',
    },
    owner: {
      type: 'object',
      properties: { id: { type: 'string' }, label: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
      'x-entity-reference': { entity_type: 'user' },
      title: 'Owner',
      description: 'The user accountable for keeping this page current.',
      'x-widget': { type: 'entity_reference_autocomplete', settings: { match_operator: 'CONTAINS' } },
      'x-field-name': 'field_owner',
    } as FrontmatterSchema['properties'][string],
    contributors: {
      type: 'array',
      items: {
        type: 'object',
        'x-entity-reference': { entity_type: 'user' },
      },
      title: 'Contributors',
      description: 'Users who contributed to this page.',
      'x-widget': { type: 'entity_reference_autocomplete', settings: {} },
      'x-field-name': 'field_contributors',
    },
    tags: {
      type: 'array',
      items: {
        type: 'object',
        'x-entity-reference': { entity_type: 'taxonomy_term', bundles: ['kb_tags'] },
      },
      title: 'Tags',
      description: 'Free tags from the KB tags vocabulary.',
      'x-widget': { type: 'entity_reference_autocomplete_tags', settings: {} },
      'x-field-name': 'field_tags',
    },
  },
  required: ['type'],
}

describe('toFormModel', () => {
  it('preserves schema (form-display weight) order', () => {
    expect(toFormModel(SCHEMA).map(f => f.key)).toEqual([
      'type', 'summary', 'owner', 'contributors', 'tags',
    ])
  })

  it('carries the JSON:API machine name and drops the field_ prefix on the key', () => {
    const owner = toFormModel(SCHEMA).find(f => f.key === 'owner')!
    expect(owner.name).toBe('field_owner')
    expect(owner.key).toBe('owner')
  })

  it('maps a list_string field to a select with value/label options', () => {
    const type = toFormModel(SCHEMA).find(f => f.key === 'type')!
    expect(type.widget).toBe('select')
    expect(type.multiple).toBe(false)
    expect(type.options).toEqual([
      { value: 'article', label: 'Article' },
      { value: 'adr', label: 'ADR' },
      { value: 'guide', label: 'Guide' },
      { value: 'runbook', label: 'Runbook' },
    ])
  })

  it('marks a field listed in `required`', () => {
    const model = toFormModel(SCHEMA)
    expect(model.find(f => f.key === 'type')!.required).toBe(true)
    expect(model.find(f => f.key === 'summary')!.required).toBe(false)
  })

  it('maps a string_long field to a textarea and lifts placeholder + rows hints', () => {
    const summary = toFormModel(SCHEMA).find(f => f.key === 'summary')!
    expect(summary.widget).toBe('textarea')
    expect(summary.rows).toBe(3)
    expect(summary.placeholder).toBe('One-paragraph abstract for listings and search.')
    expect(summary.options).toEqual([])
    expect(summary.reference).toBeNull()
  })

  it('maps a single entity reference and reads its target from x-entity-reference', () => {
    const owner = toFormModel(SCHEMA).find(f => f.key === 'owner')!
    expect(owner.widget).toBe('reference')
    expect(owner.multiple).toBe(false)
    expect(owner.reference).toEqual({ entityType: 'user', bundles: [] })
  })

  it('maps a multi-value reference and reads bundles off the items schema', () => {
    const model = toFormModel(SCHEMA)
    const contributors = model.find(f => f.key === 'contributors')!
    expect(contributors.widget).toBe('reference')
    expect(contributors.multiple).toBe(true)
    expect(contributors.reference).toEqual({ entityType: 'user', bundles: [] })

    const tags = model.find(f => f.key === 'tags')!
    expect(tags.multiple).toBe(true)
    expect(tags.reference).toEqual({ entityType: 'taxonomy_term', bundles: ['kb_tags'] })
  })

  it('maps scalar JSON-Schema types to their controls', () => {
    const model = toFormModel({
      properties: {
        count: { type: 'integer', title: 'Count', 'x-widget': { type: 'number' }, 'x-field-name': 'field_count' },
        ratio: { type: 'number', title: 'Ratio', 'x-field-name': 'field_ratio' },
        flag: { type: 'boolean', title: 'Flag', 'x-widget': { type: 'boolean_checkbox' }, 'x-field-name': 'field_flag' },
        note: { type: 'string', title: 'Note', 'x-widget': { type: 'string_textfield' }, 'x-field-name': 'field_note' },
      },
    })
    expect(model.map(f => f.widget)).toEqual(['number', 'number', 'checkbox', 'text'])
  })

  it('falls back to a plain text input for a string with no textarea hint', () => {
    const model = toFormModel({
      properties: { note: { type: 'string', 'x-field-name': 'field_note' } },
    })
    expect(model[0]!.widget).toBe('text')
    expect(model[0]!.label).toBe('note') // no title → key
  })

  it('skips a property with no x-field-name (un-addressable)', () => {
    const model = toFormModel({
      properties: {
        real: { type: 'string', 'x-field-name': 'field_real' },
        ghost: { type: 'string', title: 'Ghost' },
      },
    })
    expect(model.map(f => f.key)).toEqual(['real'])
  })

  it('returns an empty model for an empty or missing schema', () => {
    expect(toFormModel({ properties: {} })).toEqual([])
    expect(toFormModel(null)).toEqual([])
    expect(toFormModel(undefined)).toEqual([])
  })
})
