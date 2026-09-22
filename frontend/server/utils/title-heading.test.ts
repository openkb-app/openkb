import { describe, it, expect } from 'vitest'
import { splitTitleHeading, storedBody } from './title-heading'

describe('splitTitleHeading', () => {
  /** What a save must be able to put back, for every stored spelling. */
  function rejoins(stored: string): boolean {
    const { titleHeading, body } = splitTitleHeading(stored)
    return titleHeading + body === stored
  }

  it('takes the heading and the blank lines under it', () => {
    expect(splitTitleHeading('# Data model {#b-3a1c9e04}\n\nEntities. {#b-71b4c8a2}\n'))
      .toEqual({ titleHeading: '# Data model {#b-3a1c9e04}\n\n', body: 'Entities. {#b-71b4c8a2}\n' })
  })

  it('leaves a body that starts with anything else alone', () => {
    expect(splitTitleHeading('## Entities {#b-1}\n')).toEqual({ titleHeading: '', body: '## Entities {#b-1}\n' })
    expect(splitTitleHeading('Plain. {#b-1}\n')).toEqual({ titleHeading: '', body: 'Plain. {#b-1}\n' })
    expect(splitTitleHeading('')).toEqual({ titleHeading: '', body: '' })
  })

  it('takes only the first heading, so a second H1 stays content', () => {
    expect(splitTitleHeading('# Title\n\n# Also a heading {#b-2}\n').body)
      .toBe('# Also a heading {#b-2}\n')
  })

  it('leaves an indented first line to the body, where a code block starts', () => {
    expect(splitTitleHeading('# Title\n    code\n').body).toBe('    code\n')
  })

  it('rejoins to the stored bytes', () => {
    for (const stored of [
      '# Title {#b-1}\n\nOne. {#b-2}\n',
      '# Title\nOne.\n',
      '# Title',
      '# Title\n\n\n  \n\nOne.\n',
      'No heading here.\n',
      '',
    ]) {
      expect(rejoins(stored), stored).toBe(true)
    }
  })
})

describe('storedBody', () => {
  /** A minted id the assertions can spell. */
  const minted = () => 'deadbeef'

  /** What every write must hold: the document comes back out of the bytes. */
  function roundTrips(titleHeading: string, title: string, body: string): boolean {
    return splitTitleHeading(storedBody(titleHeading, title, body)).body === body
  }

  it('respells the heading from the title, keeping the block id', () => {
    expect(storedBody('# Data model {#b-3a1c9e04}\n\n', 'Domain model', 'One.\n'))
      .toBe('# Domain model {#b-3a1c9e04}\n\nOne.\n')
  })

  it('mints the block id a heading carries none of — the lead section\'s anchor', () => {
    expect(storedBody('# Data model\n\n', 'Domain model', 'One.\n', minted))
      .toBe('# Domain model {#b-deadbeef}\n\nOne.\n')
    expect(storedBody('# T\n\n', 'T', 'One.\n')).toMatch(/^# T \{#b-[0-9a-f]{8}\}\n\n/)
  })

  it('gives a body that carried no heading one, so an authored H1 stays below it', () => {
    expect(storedBody('', 'Data model', '# A heading the author wrote {#b-h}\n\nbody {#b-p}\n', minted))
      .toBe('# Data model {#b-deadbeef}\n\n# A heading the author wrote {#b-h}\n\nbody {#b-p}\n')
    expect(roundTrips('', 'Data model', '# A heading the author wrote {#b-h}\n\nbody {#b-p}\n')).toBe(true)
  })

  it('sets the gap under the heading to one blank line, however the serializer left it', () => {
    // A document opening with an empty paragraph serializes with blank lines
    // of its own; swallowed into the heading on the next read, they compound.
    expect(storedBody('# T {#b-1}\n\n', 'T', '\n\nOne. {#b-2}\n')).toBe('# T {#b-1}\n\nOne. {#b-2}\n')
    expect(storedBody('# T {#b-1}\n\n\n \n', 'T', 'One. {#b-2}\n')).toBe('# T {#b-1}\n\nOne. {#b-2}\n')
    expect(storedBody('# T {#b-1}\n', 'T', 'One. {#b-2}\n')).toBe('# T {#b-1}\n\nOne. {#b-2}\n')
    expect(storedBody('', undefined, '\n\nOne. {#b-2}\n')).toBe('\n\nOne. {#b-2}\n')
  })

  it('ends the stored text with one newline, whatever the serializer emitted', () => {
    expect(storedBody('# T {#b-1}\n\n', 'T', 'One.')).toBe('# T {#b-1}\n\nOne.\n')
    expect(storedBody('# T {#b-1}\n\n', 'T', 'One.\n')).toBe('# T {#b-1}\n\nOne.\n')
    expect(storedBody('# T {#b-1}\n\n', 'T', 'One.\n\n\n')).toBe('# T {#b-1}\n\nOne.\n')
    expect(storedBody('# T {#b-1}\n\n', 'T', '')).toBe('# T {#b-1}\n\n')
  })

  it('takes the title as written, `$&` and all', () => {
    expect(storedBody('# Old {#b-1}\n\n', 'A $& B', 'x\n')).toBe('# A $& B {#b-1}\n\nx\n')
  })

  it('leaves the heading alone when the write knows no title', () => {
    expect(storedBody('# Data model {#b-1}\n\n', undefined, 'x\n')).toBe('# Data model {#b-1}\n\nx\n')
    expect(storedBody('', undefined, 'x\n')).toBe('x\n')
  })
})
