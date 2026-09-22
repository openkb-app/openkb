import { describe, it, expect } from 'vitest'
import { markdownToTree } from '#shared/utils/comark-tree'
import { chunkDocument, countTokens, DEFAULT_CHUNK_OPTIONS, type Chunk } from './comark-chunks'

/** The size the cap is in — the chunker's own estimate. */
const tokens = countTokens

async function chunksOf(markdown: string, options = DEFAULT_CHUNK_OPTIONS): Promise<Chunk[]> {
  return chunkDocument(await markdownToTree(markdown), options)
}

/** A paragraph of roughly the asked-for token count. */
function filler(words: number, word = 'checklist'): string {
  return Array.from({ length: words }, (_, i) => `${word}${i}`).join(' ')
}

describe('chunkDocument', () => {
  it('opens one chunk per heading, under the headings it sits below', async () => {
    const chunks = await chunksOf(`# Rotation notes {#b-1111}

Who is on call. {#b-2222}

## Handover {#b-3333}

What the shift hands over. {#b-4444}

### Escalation {#b-5555}

Who to wake. {#b-6666}

## Tooling {#b-7777}

Where the dashboards are. {#b-8888}
`)
    expect(chunks.map(chunk => chunk.heading_path)).toEqual([
      ['Rotation notes'],
      ['Rotation notes', 'Handover'],
      ['Rotation notes', 'Handover', 'Escalation'],
      ['Rotation notes', 'Tooling'],
    ])
    // A deeper heading closes the section above it, so no two chunks carry the
    // same words.
    expect(chunks.map(chunk => chunk.block_id)).toEqual(['b-1111', 'b-3333', 'b-5555', 'b-7777'])
    expect(chunks[1]!.text).toBe('Handover\n\nWhat the shift hands over.')
    expect(chunks.every(chunk => chunk.part === 0)).toBe(true)
  })

  it('answers the blocks before the first heading as a chunk with no path', async () => {
    const chunks = await chunksOf(`Read this first. {#b-1111}

# Rotation notes {#b-2222}

Who is on call. {#b-3333}
`)
    expect(chunks[0]).toEqual({ block_id: 'b-1111', heading_path: [], part: 0, text: 'Read this first.', cites: [], links: [] })
    expect(chunks[1]!.heading_path).toEqual(['Rotation notes'])
  })

  it('splits a section at block boundaries, each part naming its own block', async () => {
    const chunks = await chunksOf(`## Setup {#b-1111}

${filler(120)} {#b-2222}

${filler(120)} {#b-3333}

${filler(120)} {#b-4444}
`)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map(chunk => chunk.block_id)).toEqual(['b-1111', 'b-3333', 'b-4444'])
    // Split at a block boundary, not inside one: every part is part 0.
    expect(chunks.every(chunk => chunk.part === 0)).toBe(true)
    expect(chunks.every(chunk => chunk.heading_path[0] === 'Setup')).toBe(true)
  })

  it('reads a table one row per line, each cell under its column', async () => {
    const chunks = await chunksOf(`## Owners {#b-1111}

::block{#b-2222}
| Service | Owner | Pager |
| --- | --- | --- |
| search | Ada | yes |
| index | Bob | no |
::
`)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.text).toBe('Owners\n\nService: search; Owner: Ada; Pager: yes\nService: index; Owner: Bob; Pager: no')
  })

  it('splits an oversized table by rows, the parts sharing the block', async () => {
    const rows = Array.from({ length: 80 }, (_, i) => `| service-${i} | ${filler(6, 'owner')} | yes |`).join('\n')
    const chunks = await chunksOf(`## Owners {#b-1111}

::block{#b-2222}
| Service | Owner | Pager |
| --- | --- | --- |
${rows}
::
`)
    const parts = chunks.filter(chunk => chunk.block_id === 'b-2222')
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.map(chunk => chunk.part)).toEqual(parts.map((_, i) => i))
    // A row is never cut in half: every line still names its columns.
    for (const part of parts) {
      for (const line of part.text.split('\n')) expect(line).toMatch(/^Service: service-\d+; Owner: /)
    }
  })

  it('splits an oversized code block, the parts sharing the block', async () => {
    const code = Array.from({ length: 200 }, (_, i) => `const value${i} = compute(${i})`).join('\n')
    const chunks = await chunksOf(`## Example {#b-1111}

::block{#b-2222}
\`\`\`js
${code}
\`\`\`
::
`)
    const parts = chunks.filter(chunk => chunk.block_id === 'b-2222')
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.map(chunk => chunk.part)).toEqual(parts.map((_, i) => i))
    expect(parts[0]!.text).toContain('const value0 = compute(0)')
    expect(parts.at(-1)!.text).toContain('const value199 = compute(199)')
  })

  it('holds the cap over a single token run longer than it', async () => {
    const options = { targetTokens: 20, maxTokens: 30 }
    const chunks = await chunksOf(`## Payload {#b-1111}

${'a1b2c3d4'.repeat(60)} {#b-2222}
`, options)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(tokens(chunk.text)).toBeLessThanOrEqual(options.maxTokens)
  })

  it('never answers a chunk above the cap, whatever the block', async () => {
    const chunks = await chunksOf(`# Everything {#b-0000}

${filler(400)} {#b-1111}

::block{#b-2222}
| Service | Owner |
| --- | --- |
${Array.from({ length: 120 }, (_, i) => `| service-${i} | ${filler(8, 'owner')} |`).join('\n')}
::

::block{#b-3333}
\`\`\`js
${Array.from({ length: 300 }, (_, i) => `const value${i} = compute(${i})`).join('\n')}
\`\`\`
::

::block{#b-4444}
${Array.from({ length: 200 }, (_, i) => `- item ${i} ${filler(4, 'word')}`).join('\n')}
::
`)
    expect(chunks.length).toBeGreaterThan(4)
    for (const chunk of chunks) expect(tokens(chunk.text)).toBeLessThanOrEqual(DEFAULT_CHUNK_OPTIONS.maxTokens)
  })

  it('reads a list one item per line', async () => {
    const chunks = await chunksOf(`## Steps {#b-1111}

::block{#b-2222}
- pull the branch
- run the suite
::
`)
    expect(chunks[0]!.text).toBe('Steps\n\npull the branch\nrun the suite')
  })

  it('answers nothing for a page with no words', async () => {
    expect(await chunksOf('')).toEqual([])
  })

  it('keeps a block that carries no id citable through its section', async () => {
    const chunks = await chunksOf(`## Steps {#b-1111}

::block
- pull the branch
::
`)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.block_id).toBe('b-1111')
  })
})
