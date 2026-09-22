import { describe, it, expect } from 'vitest'
import { SCOPE_ALL, SCOPE_ALL_LABEL, scopeLabel } from './chat-scope'

const spaces = [
  { slug: 'handbook', name: 'Team Handbook' },
  { slug: 'ops', name: 'Operations' },
]

describe('scopeLabel', () => {
  it('names the whole knowledge base', () => {
    expect(scopeLabel(SCOPE_ALL, spaces)).toBe(SCOPE_ALL_LABEL)
  })

  it('names a space by the name it carries, not by its slug', () => {
    expect(scopeLabel('handbook', spaces)).toBe('Team Handbook')
  })

  /**
   * The turn is scoped to the slug either way, so the pill says so rather than
   * claiming the whole knowledge base. What a slug no space carries means is
   * the panel's to settle, once it has a list to settle it against.
   */
  it('names a slug it cannot resolve as itself', () => {
    expect(scopeLabel('secret-ops', spaces)).toBe('secret-ops')
    expect(scopeLabel('handbook', [])).toBe('handbook')
  })
})
