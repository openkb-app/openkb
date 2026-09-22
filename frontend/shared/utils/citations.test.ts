import { describe, it, expect } from 'vitest'
import { blockVersions } from '../../server/utils/block-versions'
import { citeKey, citeState, citeTarget, citeUrlTitle } from './citations'

/**
 * The body both sides of the wire version identically.
 *
 * `\Drupal\Tests\openkb_workflow\Kernel\PageBlocksTest::testVersionsAgreeWithTheEditor()`
 * asserts the same three versions for the same bytes: a citation made in the editor names
 * the version Drupal derives for that block, or the comparison staleness is
 * would answer at random.
 */
const PARITY_BODY = [
  '## Why the sky is blue {#b-sky}',
  '',
  'Rayleigh scattering sends short wavelengths in every direction. {#b-ray}',
  '',
  '::callout{type="info" #b-note}',
  'Sunsets are the same effect at a longer path length.',
  '::',
  '',
].join('\n')

const PARITY_VERSIONS = {
  'b-sky': 'f3abb315b802',
  'b-ray': 'e0ff367d5ce8',
  'b-note': '2b6cb608ee32',
}

describe('cite targets', () => {
  it('reads a page block, its version, and an external address', () => {
    expect(citeTarget({ nid: '42', block: 'b-1a2b', v: 'abc123abc123' }))
      .toEqual({ kind: 'doc', nid: 42, block: 'b-1a2b', v: 'abc123abc123' })
    expect(citeTarget({ url: 'https://example.org/paper' }))
      .toEqual({ kind: 'url', url: 'https://example.org/paper' })
  })

  it('takes no version without a block to hang it on', () => {
    expect(citeTarget({ nid: '42', v: 'abc123abc123' }))
      .toEqual({ kind: 'doc', nid: 42, block: null, v: null })
  })

  it('names no source where the props name none', () => {
    expect(citeTarget({})).toBeNull()
    expect(citeTarget({ nid: '0' })).toBeNull()
    expect(citeTarget({ nid: 'x' })).toBeNull()
    // A scheme that executes is not an address a chip may carry.
    expect(citeTarget({ url: 'javascript:alert(1)' })).toBeNull()
  })

  it('is one source however many times, and whatever version, it is cited', () => {
    const first = citeTarget({ nid: '42', block: 'b-1', v: 'aaaaaaaaaaaa' })!
    const later = citeTarget({ nid: '42', block: 'b-1', v: 'bbbbbbbbbbbb' })!
    expect(citeKey(first)).toBe(citeKey(later))
    expect(citeKey(citeTarget({ nid: '42', block: 'b-2', v: null })!)).not.toBe(citeKey(first))
  })

  it('calls an external source by its host', () => {
    expect(citeUrlTitle('https://example.org/a/b?c=1')).toBe('example.org')
  })
})

describe('how a citation stands', () => {
  const target = citeTarget({ nid: '42', block: 'b-1', v: 'aaaaaaaaaaaa' })!

  it('reads as made while the cited block holds the version it names', () => {
    expect(citeState(target, { 'b-1': 'aaaaaaaaaaaa' })).toBe('ok')
  })

  it('is stale once that block says something else', () => {
    expect(citeState(target, { 'b-1': 'bbbbbbbbbbbb' })).toBe('stale')
  })

  it('is dangling where the block, or the page, is not there', () => {
    expect(citeState(target, { 'b-2': 'aaaaaaaaaaaa' })).toBe('dangling')
    expect(citeState(target, null)).toBe('dangling')
  })

  it('compares nothing where there is no version to compare', () => {
    const page = citeTarget({ nid: '42' })!
    expect(citeState(page, { 'b-1': 'aaaaaaaaaaaa' })).toBe('ok')
    const unversioned = citeTarget({ nid: '42', block: 'b-1' })!
    expect(citeState(unversioned, { 'b-1': 'bbbbbbbbbbbb' })).toBe('ok')
  })

  it('never questions an external source', () => {
    expect(citeState(citeTarget({ url: 'https://example.org/' })!, null)).toBe('ok')
  })
})

describe('version parity with Drupal', () => {
  it('derives the versions PageBlocks derives', () => {
    expect(blockVersions(PARITY_BODY)).toEqual(PARITY_VERSIONS)
  })
})
