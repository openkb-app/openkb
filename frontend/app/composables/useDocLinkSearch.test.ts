import { describe, it, expect } from 'vitest'
import { docBlocks } from './useDocLinkSearch'

/** Block rows come from the page's own markdown parsed by the editor's engine, so the ids offered are the ids the read page renders. */
describe('docBlocks', () => {
  it('offers every id-bearing top-level block, labelled by its opening words', async () => {
    const md = '# Release process {#b-1111}\n\nRun the checks first. {#b-2222}\n'
    expect(await docBlocks(md)).toEqual([
      { id: 'b-1111', label: 'Release process' },
      { id: 'b-2222', label: 'Run the checks first.' },
    ])
  })

  it('skips blocks that carry no id — they have no address', async () => {
    expect(await docBlocks('No id here.\n\nThis one has one. {#b-3333}\n'))
      .toEqual([{ id: 'b-3333', label: 'This one has one.' }])
  })

  it('falls back to the id for a block with no words of its own', async () => {
    const md = '::image{file="0e5b" #b-4444}\n::\n'
    expect(await docBlocks(md)).toEqual([{ id: 'b-4444', label: 'b-4444' }])
  })

  it('shortens a long block to a label a row can hold', async () => {
    const long = `${'word '.repeat(40).trim()} {#b-5555}`
    const [block] = await docBlocks(long)
    expect(block!.label.length).toBeLessThanOrEqual(61)
    expect(block!.label.endsWith('…')).toBe(true)
  })
})
