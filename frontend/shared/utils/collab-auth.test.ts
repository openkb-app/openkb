import { describe, it, expect } from 'vitest'
import { isNoEditAccessReason, noEditAccessReason, noFieldAccessReason } from './collab-auth'

describe('noFieldAccessReason', () => {
  it('names the fields the joiner may not edit', () => {
    expect(noFieldAccessReason(12, ['title', 'field_owner']))
      .toBe(`${noEditAccessReason(12)}: cannot edit title, field_owner`)
  })

  it('says so when the site did not answer the check at all', () => {
    expect(noFieldAccessReason(12, null))
      .toBe(`${noEditAccessReason(12)}: the site did not answer the field-access check`)
  })

  it('reads as no-access, so the client shows that and not "not signed in"', () => {
    expect(isNoEditAccessReason(noFieldAccessReason(12, ['title']))).toBe(true)
    expect(isNoEditAccessReason(noFieldAccessReason(12, null))).toBe(true)
  })
})
