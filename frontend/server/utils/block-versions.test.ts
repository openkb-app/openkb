import { describe, it, expect } from 'vitest'
import { blockSegments, blockSegmentsOfDoc, blockVersion, blockVersions, keepStoredSpellingOfUntouchedBlocks } from './block-versions'
import type { ProseMirrorJSON } from './commit'
import { parseMarkdownToJson } from '../../app/comark/markdown-engine'

const BODY = 'Intro line. {#b-1}\n\n## A heading {#b-2}\n'

/**
 * Body → the id its one block carries, or null. The editor, this side and
 * Drupal agree on each: `PageBlocksTest::testTrailingIdAgreesWithTheEditor()`
 * holds the same cases.
 */
const TRAILING_IDS: [string, string | null][] = [
  ['a {#x}', 'x'],
  ['## C {#x}', 'x'],
  ['{#x}', 'x'],
  [' {#x}', 'x'],
  ['**b** {#x}', 'x'],
  ['**b**\\{#x}', null],
  ['**b**{#x}', null],
  ['end\\{#x}', null],
  ['end{#x}', null],
  ['## C #\\{#b-123}', null],
  ['a\n\\{#x}', null],
  ['a\\\n\\{#x}', null],
  ['a *b {#x}*', null],
  ['**b {#x}**', null],
  ['see [a {#x}](u)', null],
  ['see `a {#x}`', null],
]

/**
 * Hand-written bodies the editor, reading as comark does, reads otherwise: an
 * id alone is no block to it, and `{#x}` right after text is the block's id.
 * The editor writes neither form: `text {#x}`, and no id on an empty block.
 */
const COMARK_READS: Record<string, string | null> = { '{#x}': null, ' {#x}': null, 'end{#x}': 'x' }

describe('trailing block id', () => {
  it.each(TRAILING_IDS)('reads the trailing id of %j as the editor does', async (body, id) => {
    expect([...blockSegments(body).keys()]).toEqual(id === null ? [] : [id])
    const editor = body in COMARK_READS ? COMARK_READS[body] : id
    expect((await parseMarkdownToJson(body)).content?.[0]?.attrs?.id ?? null).toBe(editor)
  })
})

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

  it('splits as PageBlocksTest pins it for multibyte letters and Unicode whitespace', () => {
    const block = 'Ångström ąż хор\nÅ. {#b-1}'
    expect(Object.fromEntries(blockSegments(`${block}\n\nTwo. {#b-2}`))).toEqual({ 'b-1': block, 'b-2': 'Two. {#b-2}' })
    expect([...blockSegments('\u00A0```\na\n\nb\n```\u00A0\n\nAfter. {#b-after}').keys()]).toEqual(['b-after'])
    expect([...blockSegments('::\u00A0x {#b-1}\n\nTwo. {#b-2}').keys()]).toEqual(['b-1', 'b-2'])
    for (const space of ['\u00A0', '\u3000']) {
      expect([...blockSegments(`::callout{#b-1}${space}\nText\n::\n\nTwo. {#b-2}${space}`).keys()]).toEqual(['b-1', 'b-2'])
    }
  })

  it('versions only what an op can name', () => {
    // No id: unaddressable, so nothing can expect a version for it.
    expect(Object.keys(blockVersions('No id here.\n\nWith id. {#b-1}\n'))).toEqual(['b-1'])
  })

  it('versions a leading heading the same on both sides', async () => {
    // The title heading is off the document and off the stored body, so a
    // leading `#` heading in either is a block like any other.
    const doc = { type: 'doc', content: [
      { type: 'heading', attrs: { id: 'b-x', level: 1 }, content: [{ type: 'text', text: 'Section' }] },
      { type: 'paragraph', attrs: { id: 'b-1' }, content: [{ type: 'text', text: 'Body.' }] },
    ] } as ProseMirrorJSON

    expect([...(await blockSegmentsOfDoc(doc)).keys()]).toEqual(['b-x', 'b-1'])
    expect(Object.keys(blockVersions('# Section {#b-x}\n\nBody. {#b-1}\n'))).toEqual(['b-x', 'b-1'])
  })

  it('versions a block whose last span is marked', async () => {
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
    expect([...(await blockSegmentsOfDoc(doc)).keys()]).toEqual(['b-1'])
  })

  it('keeps a fenced block whole', () => {
    const segments = blockSegments('::callout{type="info" #b-9}\nBody text.\n\nSecond para.\n::\n')
    expect([...segments.keys()]).toEqual(['b-9'])
    expect(segments.get('b-9')).toContain('Second para.')
  })

  it('keeps a tilde-fenced code block holding a backtick fence line whole', () => {
    const segments = blockSegments('~~~\n```\n\nx\n~~~\n\nAfter. {#b-after}')
    expect([...segments.keys()]).toEqual(['b-after'])
  })

  it('reads the same off a document as off the markdown it serves', async () => {
    // The whole point: getPageForEditing hashes the body it serves,
    // updateBlocks the live document. They must never disagree about an
    // untouched block.
    const json = { type: 'doc', content: [
      { type: 'paragraph', attrs: { id: 'b-1' }, content: [{ type: 'text', text: 'Intro line.' }] },
      { type: 'heading', attrs: { id: 'b-2', level: 2 }, content: [{ type: 'text', text: 'A heading' }] },
    ] } as ProseMirrorJSON
    expect(await blockSegmentsOfDoc(json)).toEqual(blockSegments(BODY))
    expect(blockVersion((await blockSegmentsOfDoc(json)).get('b-1')!)).toBe(blockVersions(BODY)['b-1'])
  })
})

describe('keepStoredSpellingOfUntouchedBlocks', () => {
  const STORED = 'One. {#b-1}\n\n_Two._ {#b-2}\n\nThree __bold__. {#b-3}\n'

  it('writes an untouched block in its stored bytes, and an edited one canonically', async () => {
    const written = 'One, edited. {#b-1}\n\n*Two.* {#b-2}\n\nThree **bold**. {#b-3}'
    expect(await keepStoredSpellingOfUntouchedBlocks(STORED, written))
      .toBe('One, edited. {#b-1}\n\n_Two._ {#b-2}\n\nThree __bold__. {#b-3}')
  })

  it('writes a block canonically once its content changed', async () => {
    const written = 'One. {#b-1}\n\n*Two, edited.* {#b-2}\n\nThree **bold**. {#b-3}'
    expect(await keepStoredSpellingOfUntouchedBlocks(STORED, written))
      .toBe('One. {#b-1}\n\n*Two, edited.* {#b-2}\n\nThree __bold__. {#b-3}')
  })

  it('keeps inline HTML the serializer drops, as long as nobody edits the block', async () => {
    const stored = 'Press <kbd>K</kbd> now. {#b-1}\n'
    expect(await keepStoredSpellingOfUntouchedBlocks(stored, 'Press K now. {#b-1}')).toBe('Press <kbd>K</kbd> now. {#b-1}')
  })

  it('writes a block canonically when its stored bytes lean on a link reference definition', async () => {
    const stored = 'See [x][ref]. {#b-1}\n\n[ref]: https://example.com\n'
    const written = 'See [x](https://example.com). {#b-1}'
    expect(await keepStoredSpellingOfUntouchedBlocks(stored, written)).toBe(written)
  })

  it('keeps the stored bytes of an untouched block that moved', async () => {
    const written = 'Three **bold**. {#b-3}\n\nOne. {#b-1}\n\n*Two.* {#b-2}'
    expect(await keepStoredSpellingOfUntouchedBlocks(STORED, written))
      .toBe('Three __bold__. {#b-3}\n\nOne. {#b-1}\n\n_Two._ {#b-2}')
  })

  it('keeps the stored bytes of a callout whose body is re-spelled', async () => {
    const stored = '::callout{#b-1}\n_Careful._\n::\n\nTwo. {#b-2}\n'
    const written = '::callout{type="info" #b-1}\n*Careful.*\n::\n\nTwo, edited. {#b-2}'
    expect(await keepStoredSpellingOfUntouchedBlocks(stored, written))
      .toBe('::callout{#b-1}\n_Careful._\n::\n\nTwo, edited. {#b-2}')
  })

  it('writes an unclosed callout canonically once a block follows it', async () => {
    const stored = 'One. {#b-1}\n\n::callout{#b-2}\n_Careful._\n'
    const written = 'One. {#b-1}\n\n::callout{type="info" #b-2}\n*Careful.*\n::\n\nAppended. {#b-3}'
    expect(await keepStoredSpellingOfUntouchedBlocks(stored, written)).toBe(written)
  })

  it('keeps the stored bytes of an unclosed callout that stays last', async () => {
    const stored = 'One. {#b-1}\n\n::callout{#b-2}\n_Careful._\n'
    const written = 'One, edited. {#b-1}\n\n::callout{type="info" #b-2}\n*Careful.*\n::'
    expect(await keepStoredSpellingOfUntouchedBlocks(stored, written))
      .toBe('One, edited. {#b-1}\n\n::callout{#b-2}\n_Careful._')
  })

  it('keeps the other blocks\' stored bytes when one cannot be kept', async () => {
    const stored = '_One._ {#b-1}\n\n::callout{#b-2}\n_Careful._\n'
    const written = '*One.* {#b-1}\n\n::callout{type="info" #b-2}\n*Careful.*\n::\n\nAppended. {#b-3}'
    expect(await keepStoredSpellingOfUntouchedBlocks(stored, written))
      .toBe('_One._ {#b-1}\n\n::callout{type="info" #b-2}\n*Careful.*\n::\n\nAppended. {#b-3}')
  })

  it('writes a callout canonically when Drupal would not close it before the next block', async () => {
    // comark closes the fence on the indented `::`, Drupal's segmentation only at column 0.
    const stored = 'One. {#b-1}\n\n::callout{#b-2}\n_Careful._\n  ::\n'
    const written = 'One. {#b-1}\n\n::callout{type="info" #b-2}\n*Careful.*\n::\n\nAppended. {#b-3}'
    expect(await keepStoredSpellingOfUntouchedBlocks(stored, written)).toBe(written)
  })

  it('keeps the stored bytes of a callout with an indented closer that stays last', async () => {
    const stored = 'One. {#b-1}\n\n::callout{#b-2}\n_Careful._\n  ::\n'
    const written = 'One, edited. {#b-1}\n\n::callout{type="info" #b-2}\n*Careful.*\n::'
    expect(await keepStoredSpellingOfUntouchedBlocks(stored, written))
      .toBe('One, edited. {#b-1}\n\n::callout{#b-2}\n_Careful._\n  ::')
  })

  it('keeps the stored bytes of every block before a callout written closed', async () => {
    const numbers = Array.from({ length: 22 }, (_, at) => at + 1)
    const stored = numbers.map(n => `_${n}._ {#b-${n}}`).join('\n\n') + '\n\n::callout{#b-c}\n_Careful._\n'
    const callout = '::callout{type="info" #b-c}\n*Careful.*\n::'
    const written = [...numbers.map(n => `*${n}.* {#b-${n}}`), callout, 'Appended. {#b-new}'].join('\n\n')
    const expected = [...numbers.map(n => `_${n}._ {#b-${n}}`), callout, 'Appended. {#b-new}'].join('\n\n')
    expect(await keepStoredSpellingOfUntouchedBlocks(stored, written)).toBe(expected)
  })

  it('leaves a body with nothing re-spelled as written', async () => {
    const written = 'One. {#b-1}\n\n*New.* {#b-9}'
    expect(await keepStoredSpellingOfUntouchedBlocks(STORED, written)).toBe(written)
  })
})
