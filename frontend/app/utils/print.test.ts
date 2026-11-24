import { describe, it, expect } from 'vitest'
import { cssString } from './print'

describe('cssString', () => {
  it('keeps plain text as it is', () => {
    expect(cssString('Getting started')).toBe('Getting started')
  })

  it('escapes what would end the string or the style element', () => {
    expect(cssString('a "b" \\ c')).toBe('a \\"b\\" \\\\ c')
    expect(cssString('</style><script>')).toBe('\\3C /style>\\3C script>')
    expect(cssString('one\ntwo')).toBe('one\\A two')
  })
})
