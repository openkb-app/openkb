import { describe, it, expect } from 'vitest'
import { deadMailedLink } from './mailed-links'

/**
 * Which refused or missing pages are a mailed link that no longer works.
 */

describe('deadMailedLink', () => {
  it('takes any refused one-time login for a refused login link', () => {
    expect(deadMailedLink('/user/reset/12/1764144000/abc', 403, false)).toBe('login-refused')
    expect(deadMailedLink('/user/reset/12', 403, true)).toBe('login-refused')
  })

  it('takes a missing accept page for a gone invite, signed in or not', () => {
    expect(deadMailedLink('/invite/7', 404, false)).toBe('invite-gone')
    expect(deadMailedLink('/invite/7', 404, true)).toBe('invite-gone')
  })

  it('takes a refused accept page for a closed invite only when signed in', () => {
    expect(deadMailedLink('/invite/7', 403, true)).toBe('invite-closed')
    expect(deadMailedLink('/invite/7', 403, false)).toBeNull()
  })

  it('leaves other paths and statuses alone', () => {
    expect(deadMailedLink('/invite/7', 503, true)).toBeNull()
    expect(deadMailedLink('/user/reset/12/1764144000/abc', 500, false)).toBeNull()
    expect(deadMailedLink('/getting-started', 403, true)).toBeNull()
    expect(deadMailedLink('/invite/7/edit', 404, true)).toBeNull()
  })
})
