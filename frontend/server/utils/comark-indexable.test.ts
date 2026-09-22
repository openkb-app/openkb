import { describe, it, expect } from 'vitest'
import { markdownToIndexable } from './comark-indexable'

describe('markdownToIndexable', () => {
  it('returns no chunk for empty markdown', async () => {
    expect(await markdownToIndexable('')).toEqual({ chunks: [] })
  })

  it('answers one section per heading, the page heading in their path', async () => {
    const out = await markdownToIndexable('# Rotation notes {#b-1111}\n\nwho is on call {#b-2222}\n\n## Handover {#b-3333}\n\nwhat the shift hands over {#b-4444}\n')
    expect(out.chunks).toEqual([
      { block_id: 'b-1111', heading_path: ['Rotation notes'], part: 0, text: 'Rotation notes\n\nwho is on call', cites: [], links: [] },
      { block_id: 'b-3333', heading_path: ['Rotation notes', 'Handover'], part: 0, text: 'Handover\n\nwhat the shift hands over', cites: [], links: [] },
    ])
  })

  it('carries what the chunk\u2019s blocks cite and link to', async () => {
    const out = await markdownToIndexable([
      '# Page {#b-1111}',
      '',
      'Derived from it. :citation{nid="42" block="b-4f2a" v="aaaaaaaaaaaa"} {#b-2222}',
      '',
      'See :doc[Release process]{nid="7"} and :citation{url="https://example.org/"}. {#b-3333}',
    ].join('\n'))
    expect(out.chunks).toHaveLength(1)
    // The page and the block are both edges; an external citation is neither.
    expect(out.chunks[0]).toMatchObject({ cites: ['42', '42#b-4f2a'], links: ['7'] })
  })

  it('carries the edges of a block that is nothing but a citation', async () => {
    const out = await markdownToIndexable([
      'Prose here. {#b-1111}',
      '',
      ':citation{nid="42" block="b-a" v="aaaaaaaaaaaa"} {#b-2222}',
    ].join('\n'))
    // A citation is no words, so that block is no chunk of its own — but the
    // chunk it sits in still says what it cites.
    expect(out.chunks).toHaveLength(1)
    expect(out.chunks[0]).toMatchObject({ text: 'Prose here.', cites: ['42', '42#b-a'] })
  })

  it('gives each section only the edges its own blocks hold', async () => {
    const out = await markdownToIndexable([
      '## First {#b-1111}',
      '',
      'Derived. :citation{nid="42" block="b-a" v="aaaaaaaaaaaa"} {#b-2222}',
      '',
      '## Second {#b-3333}',
      '',
      'Elsewhere. :citation{nid="7" block="b-b" v="bbbbbbbbbbbb"} {#b-4444}',
    ].join('\n'))
    expect(out.chunks.map(chunk => chunk.cites)).toEqual([['42', '42#b-a'], ['7', '7#b-b']])
  })

  it('chunks to the token target and cap the caller names', async () => {
    const md = `# Page {#b-1111}\n\n${'word '.repeat(80)} {#b-2222}\n\n${'other '.repeat(80)} {#b-3333}\n`
    const wide = await markdownToIndexable(md, undefined, { targetTokens: 300, maxTokens: 500 })
    const narrow = await markdownToIndexable(md, undefined, { targetTokens: 20, maxTokens: 40 })
    expect(narrow.chunks.length).toBeGreaterThan(wide.chunks.length)
  })

  it('indexes a document link as its words', async () => {
    const out = await markdownToIndexable('See :doc[Release process]{nid="42"} first. {#b-71c2}')
    expect(out.chunks[0]!.text).toContain('Release process')
  })

  it('keeps script and style out of the sections', async () => {
    const out = await markdownToIndexable('<style>p{color:red}</style>\n\n<script>alert(1)</script>\n\nVisible. {#b-71c2}\n')
    const text = out.chunks.map(chunk => chunk.text).join('\n')
    expect(text).not.toContain('alert(1)')
    expect(text).toContain('Visible.')
  })

  it('carries the words of a component body', async () => {
    const out = await markdownToIndexable('# Page {#b-1111}\n\n::callout{type="info"}\ninside callout\n::\n')
    expect(out.chunks.map(chunk => chunk.text).join('\n')).toContain('inside callout')
  })
})
