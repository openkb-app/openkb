import { describe, it, expect } from 'vitest'
import { loggablePath } from './loggable-path'

describe('loggablePath', () => {
  it('drops the timestamp and hash of a one-time login path', () => {
    expect(loggablePath('/user/reset/14/1794988539/_Z48628L2hrb/login')).toBe('/user/reset/14/…')
    expect(loggablePath('/user/reset/14/1794988539/_Z48628L2hrb')).toBe('/user/reset/14/…')
  })

  it('drops them behind a prefix', () => {
    expect(loggablePath('/ce-api/user/reset/14/1794988539/_Z48628L2hrb')).toBe('/ce-api/user/reset/14/…')
  })

  it('drops them in any letter case', () => {
    expect(loggablePath('/User/Reset/14/1794988539/_Z48628L2hrb/login')).toBe('/User/Reset/14/…')
  })

  it('keeps any other path', () => {
    expect(loggablePath('/user/reset/14')).toBe('/user/reset/14')
    expect(loggablePath('/handbook/start')).toBe('/handbook/start')
  })
})
