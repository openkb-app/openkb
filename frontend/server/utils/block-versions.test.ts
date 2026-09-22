import { describe, it, expect } from 'vitest'
import { blockSegments, blockSegmentsOfDoc, blockVersion, blockVersions } from './block-versions'
import type { ProseMirrorJSON } from './commit'

const BODY = 'Intro line. {#b-1}\n\n## A heading {#b-2}\n'

/**
 * Every body here is canonical markdown, because that is what both entry
 * points take. Canonicalizing a stored body is the read path's job and is
 * covered where it happens (server/utils/kb-read.test.ts).
 */
describe('block versions', () => {
  it('is stable, short, and per-block', () => {
    const versions = blockVersions(BODY)
    expect(Object.keys(versions)).toEqual(['b-1', 'b-2'])
    expect(versions['b-1']).toMatch(/^[0-9a-f]{12}$/)
    expect(blockVersions(BODY)).toEqual(versions)
    // A change to one block leaves the others' versions alone.
    const edited = blockVersions('Intro line, edited. {#b-1}\n\n## A heading {#b-2}\n')
    expect(edited['b-2']).toBe(versions['b-2'])
    expect(edited['b-1']).not.toBe(versions['b-1'])
  })

  it('versions only what an op can name', () => {
    // No id: unaddressable, so nothing can expect a version for it.
    expect(Object.keys(blockVersions('No id here.\n\nWith id. {#b-1}\n'))).toEqual(['b-1'])
  })

  it('versions a leading heading the same on both sides', () => {
    // The title heading is off the document and off the stored body, so a
    // leading `#` heading in either is a block like any other.
    const doc = { type: 'doc', content: [
      { type: 'heading', attrs: { id: 'b-x', level: 1 }, content: [{ type: 'text', text: 'Section' }] },
      { type: 'paragraph', attrs: { id: 'b-1' }, content: [{ type: 'text', text: 'Body.' }] },
    ] } as ProseMirrorJSON

    expect([...blockSegmentsOfDoc(doc).keys()]).toEqual(['b-x', 'b-1'])
    expect(Object.keys(blockVersions('# Section {#b-x}\n\nBody. {#b-1}\n'))).toEqual(['b-x', 'b-1'])
  })

  it('versions a block whose last span is marked', () => {
    // The id is a marker, not content: it sits outside the mark on both sides,
    // or the block loses its version and an op can no longer expect one.
    const body = 'Ends in **bold**. {#b-1}\n\nEnds in *emphasis*. {#b-2}\n\n'
      + 'Ends in `code`. {#b-3}\n\nEnds in [a link](https://example.com). {#b-4}\n'
    expect(Object.keys(blockVersions(body))).toEqual(['b-1', 'b-2', 'b-3', 'b-4'])

    const doc = { type: 'doc', content: [
      { type: 'paragraph', attrs: { id: 'b-1' }, content: [
        { type: 'text', text: 'Ends in ' },
        { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
      ] },
    ] } as ProseMirrorJSON
    expect([...blockSegmentsOfDoc(doc).keys()]).toEqual(['b-1'])
  })

  it('keeps a fenced block whole', () => {
    const segments = blockSegments('::callout{type="info" #b-9}\nBody text.\n\nSecond para.\n::\n')
    expect([...segments.keys()]).toEqual(['b-9'])
    expect(segments.get('b-9')).toContain('Second para.')
  })

  it('reads the same off a document as off the markdown it serves', () => {
    // The whole point: getPageForEditing hashes the body it serves,
    // updateBlocks the live document. They must never disagree about an
    // untouched block.
    const json = { type: 'doc', content: [
      { type: 'paragraph', attrs: { id: 'b-1' }, content: [{ type: 'text', text: 'Intro line.' }] },
      { type: 'heading', attrs: { id: 'b-2', level: 2 }, content: [{ type: 'text', text: 'A heading' }] },
    ] } as ProseMirrorJSON
    expect(blockSegmentsOfDoc(json)).toEqual(blockSegments(BODY))
    expect(blockVersion(blockSegmentsOfDoc(json).get('b-1')!)).toBe(blockVersions(BODY)['b-1'])
  })
})
