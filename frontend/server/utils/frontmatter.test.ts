import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import type { FieldSpec, FieldValues } from './entity-fields'
import {
  FrontmatterError,
  parseFields,
  projectFields,
  projectMarkdown,
  splitFrontmatter,
} from './frontmatter'

/**
 * The v1 exposed field set (OKB-9): a scalar enum, a scalar string, a single
 * user ref, multi user refs, multi term refs. Standing in for whatever the
 * `frontmatter` form display exposes — the codec never names a field itself.
 */
const SPECS: FieldSpec[] = [
  { key: 'type', name: 'field_type', multiple: false, reference: false },
  { key: 'summary', name: 'field_summary', multiple: false, reference: false },
  { key: 'owner', name: 'field_owner', multiple: false, reference: true },
  { key: 'contributors', name: 'field_contributors', multiple: true, reference: true },
  { key: 'tags', name: 'field_tags', multiple: true, reference: true },
]

const BODY = '# Heading\n\nA paragraph.\n\n::callout{type="info"}\nNote.\n::'

describe('projectMarkdown', () => {
  it('projects a frontmatter block above the body, in form-display order', () => {
    const values: FieldValues = {
      title: 'ignored — not a frontmatter field',
      type: 'adr',
      summary: 'A short summary.',
      owner: { id: 'u-1', label: 'admin' },
      contributors: [{ id: 'u-2', label: 'alice' }],
      tags: [{ id: 't-1', label: 'architecture' }, { id: 't-2', label: 'ops' }],
    }
    const md = projectMarkdown(SPECS, values, BODY)

    expect(md.startsWith('---\n')).toBe(true)
    const { frontmatter, body } = splitFrontmatter(md)
    expect(body).toBe(BODY)

    const parsed = parseYaml(frontmatter!) as Record<string, unknown>
    // Key order follows the specs, not the values object.
    expect(Object.keys(parsed)).toEqual(['type', 'summary', 'owner', 'contributors', 'tags'])
    expect(parsed.type).toBe('adr')
    expect(parsed.owner).toEqual({ id: 'u-1', label: 'admin' })
    // The node title is not part of the frontmatter contract.
    expect(parsed).not.toHaveProperty('title')
  })

  it('exposes exposed-but-empty fields with their shape', () => {
    const md = projectMarkdown(SPECS, { type: null, tags: [] }, BODY)
    const parsed = parseYaml(splitFrontmatter(md).frontmatter!) as Record<string, unknown>
    expect(parsed.type).toBeNull()
    expect(parsed.owner).toBeNull()
    expect(parsed.tags).toEqual([])
    expect(parsed.contributors).toEqual([])
  })

  it('emits no frontmatter block when no fields are exposed', () => {
    expect(projectMarkdown([], { type: 'adr' }, BODY)).toBe(BODY)
  })

  it('reflects the exposure contract with zero code change (field removed)', () => {
    const without = SPECS.filter(spec => spec.key !== 'type')
    const parsed = parseYaml(
      splitFrontmatter(projectMarkdown(without, { type: 'adr', summary: 's' }, BODY)).frontmatter!,
    ) as Record<string, unknown>
    expect(parsed).not.toHaveProperty('type')
    expect(parsed).toHaveProperty('summary')
  })
})

describe('projectFields', () => {
  it('defaults a missing scalar to null and a missing list to []', () => {
    expect(projectFields(SPECS, {})).toEqual({
      type: null,
      summary: null,
      owner: null,
      contributors: [],
      tags: [],
    })
  })

  it('keeps falsy scalars (0, false, empty string) rather than nulling them', () => {
    const specs: FieldSpec[] = [
      { key: 'count', name: 'field_count', multiple: false, reference: false },
      { key: 'flag', name: 'field_flag', multiple: false, reference: false },
      { key: 'note', name: 'field_note', multiple: false, reference: false },
    ]
    expect(projectFields(specs, { count: 0, flag: false, note: '' })).toEqual({
      count: 0,
      flag: false,
      note: '',
    })
  })
})

describe('splitFrontmatter', () => {
  it('returns null frontmatter and the whole input as body when absent', () => {
    expect(splitFrontmatter('just a body')).toEqual({ frontmatter: null, body: 'just a body' })
  })

  it('leaves the body byte-identical after the block', () => {
    const raw = '---\ntype: adr\n---\n\n# Body\n\ntext'
    expect(splitFrontmatter(raw)).toEqual({ frontmatter: 'type: adr', body: '# Body\n\ntext' })
  })

  it('handles a block with no blank line before the body', () => {
    expect(splitFrontmatter('---\ntype: adr\n---\nbody').body).toBe('body')
  })
})

describe('parseFields — validation (OKB-44 4xx)', () => {
  it('rejects an unknown/unexposed key, naming it', () => {
    let error: FrontmatterError | undefined
    try {
      parseFields(SPECS, 'type: adr\nsecret: leaked')
    }
    catch (err) {
      error = err as FrontmatterError
    }
    expect(error).toBeInstanceOf(FrontmatterError)
    expect(error!.keys).toEqual(['secret'])
    expect(error!.message).toContain('secret')
  })

  it('rejects a removed field once the form mode drops it', () => {
    const without = SPECS.filter(spec => spec.key !== 'type')
    expect(() => parseFields(without, 'type: adr')).toThrow(FrontmatterError)
  })

  it('rejects a non-mapping frontmatter block', () => {
    expect(() => parseFields(SPECS, '- a\n- b')).toThrow(/must be a YAML mapping/)
  })

  it('rejects invalid YAML', () => {
    expect(() => parseFields(SPECS, 'type: [unterminated')).toThrow(/Invalid YAML/)
  })

  it('rejects a scalar where a list is expected', () => {
    expect(() => parseFields(SPECS, 'tags: architecture')).toThrow(/must be a YAML list/)
  })

  it('rejects a reference missing its id', () => {
    expect(() => parseFields(SPECS, 'owner:\n  label: admin')).toThrow(/missing a string "id"/)
  })

  it('rejects a non-scalar scalar field', () => {
    expect(() => parseFields(SPECS, 'summary:\n  nested: true')).toThrow(/expects a scalar/)
  })

  it('accepts an empty / null block as no field values', () => {
    expect(parseFields(SPECS, '')).toEqual({})
  })
})

/**
 * Round-trip property (extends the OKB-10 corpus pattern): for each field-value
 * case, projecting to frontmatter and parsing it back yields identical field
 * values. One `it` per case, like the round-trip corpus runner.
 */
describe('round-trip: parseFields(project(values)) === values', () => {
  const CASES: Array<{ name: string, values: FieldValues }> = [
    { name: 'fully populated', values: {
      type: 'adr',
      summary: 'Decide the wire format.',
      owner: { id: 'u-1', label: 'admin' },
      contributors: [{ id: 'u-2', label: 'alice' }, { id: 'u-3', label: 'bob' }],
      tags: [{ id: 't-1', label: 'architecture' }],
    } },
    { name: 'all empty', values: {
      type: null, summary: null, owner: null, contributors: [], tags: [],
    } },
    { name: 'unresolved ref label degrades to empty string', values: {
      type: 'guide', summary: '', owner: { id: 'u-9', label: '' }, contributors: [], tags: [],
    } },
    { name: 'summary with colons, quotes and newlines', values: {
      type: 'runbook',
      summary: 'Line one: "quoted".\nLine two — dash.',
      owner: null, contributors: [], tags: [],
    } },
    { name: 'numeric-looking string stays a string', values: {
      type: '123', summary: '007', owner: null, contributors: [], tags: [],
    } },
  ]

  for (const { name, values } of CASES) {
    it(name, () => {
      const md = projectMarkdown(SPECS, values, BODY)
      const { frontmatter } = splitFrontmatter(md)
      expect(parseFields(SPECS, frontmatter!)).toEqual(values)
    })
  }
})
