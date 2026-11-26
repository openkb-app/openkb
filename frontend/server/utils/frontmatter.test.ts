import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import type { FieldSpec, FieldValues } from './entity-fields'
import { projectFields, projectMarkdown } from './frontmatter'

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

/** A projected document's frontmatter block and its body. */
function splitDocument(md: string): { frontmatter: string, body: string } {
  const [, frontmatter = '', body = ''] = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(md) ?? []
  return { frontmatter, body }
}

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
    const { frontmatter, body } = splitDocument(md)
    expect(body).toBe(BODY)

    const parsed = parseYaml(frontmatter) as Record<string, unknown>
    // Key order follows the specs, not the values object.
    expect(Object.keys(parsed)).toEqual(['type', 'summary', 'owner', 'contributors', 'tags'])
    expect(parsed.type).toBe('adr')
    expect(parsed.owner).toEqual({ id: 'u-1', label: 'admin' })
    // The node title is not part of the frontmatter contract.
    expect(parsed).not.toHaveProperty('title')
  })

  it('exposes exposed-but-empty fields with their shape', () => {
    const md = projectMarkdown(SPECS, { type: null, tags: [] }, BODY)
    const parsed = parseYaml(splitDocument(md).frontmatter) as Record<string, unknown>
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
      splitDocument(projectMarkdown(without, { type: 'adr', summary: 's' }, BODY)).frontmatter,
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
