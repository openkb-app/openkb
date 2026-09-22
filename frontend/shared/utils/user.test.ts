import { describe, it, expect } from 'vitest'
import { ANONYMOUS_USER, backendUrl, userAvatar, userInitials, type OkbUser } from './user'

function user(overrides: Partial<OkbUser> = {}): OkbUser {
  return { ...ANONYMOUS_USER, name: 'Jane Doe', uid: 7, ...overrides }
}

describe('userInitials', () => {
  it('takes the first letter of the first two words', () => {
    expect(userInitials('Lena Kowalski')).toBe('LK')
    expect(userInitials('Ada Byron Lovelace')).toBe('AB')
  })

  it('takes two letters from a single-word name', () => {
    expect(userInitials('admin')).toBe('AD')
    expect(userInitials('e')).toBe('E')
  })

  it('treats punctuation as a word separator', () => {
    expect(userInitials('wolfgang.ziegler')).toBe('WZ')
    expect(userInitials('jane_doe')).toBe('JD')
  })

  it('is empty for a nameless session', () => {
    expect(userInitials(null)).toBe('')
    expect(userInitials(undefined)).toBe('')
    expect(userInitials('   ')).toBe('')
  })
})

describe('userAvatar', () => {
  it('shows the Drupal picture, keeping initials as the load-failure fallback', () => {
    expect(userAvatar(user({ picture: 'http://drupal.test/pictures/jane.png' })))
      .toEqual({ src: 'http://drupal.test/pictures/jane.png', text: 'JD', icon: undefined })
  })

  it('falls back to initials when the account has no picture', () => {
    expect(userAvatar(user())).toEqual({ src: undefined, text: 'JD', icon: undefined })
  })

  it('falls back to a person icon when there is no name to initial', () => {
    expect(userAvatar(ANONYMOUS_USER)).toEqual({ src: undefined, text: undefined, icon: 'i-lucide-user' })
    expect(userAvatar(null)).toEqual({ src: undefined, text: undefined, icon: 'i-lucide-user' })
  })
})

describe('backendUrl', () => {
  it('joins a backend path onto the configured origin', () => {
    expect(backendUrl('http://drupal.test', '/admin')).toBe('http://drupal.test/admin')
    expect(backendUrl('http://drupal.test/', '/user/7/edit')).toBe('http://drupal.test/user/7/edit')
  })

  it('stays a same-origin path when no backend origin is configured', () => {
    expect(backendUrl(undefined, '/admin')).toBe('/admin')
  })
})
