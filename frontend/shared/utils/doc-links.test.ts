import { describe, it, expect } from 'vitest'
import { docLinkHref, docLinkTarget } from './doc-links'

describe('docLinkTarget', () => {
  it('reads the nid and the optional block', () => {
    expect(docLinkTarget({ nid: '42' })).toEqual({ nid: 42, block: null })
    expect(docLinkTarget({ nid: '42', block: 'b-4f2a' })).toEqual({ nid: 42, block: 'b-4f2a' })
  })

  it('refuses props that name no page', () => {
    expect(docLinkTarget({})).toBeNull()
    expect(docLinkTarget({ nid: 'nope' })).toBeNull()
    expect(docLinkTarget({ nid: '0' })).toBeNull()
    expect(docLinkTarget({ nid: '-1' })).toBeNull()
  })
})

describe('docLinkHref', () => {
  it('uses the target’s own alias when the reader may see it', () => {
    expect(docLinkHref(42, '/handbook/release', null)).toBe('/handbook/release')
    expect(docLinkHref(42, '/handbook/release', 'b-4f2a')).toBe('/handbook/release#b-4f2a')
  })

  it('falls back to the canonical path, which Drupal answers 404 for', () => {
    expect(docLinkHref(42, null, null)).toBe('/node/42')
    expect(docLinkHref(42, null, 'b-4f2a')).toBe('/node/42#b-4f2a')
  })
})
