/**
 * The chunk contract the sidecar answers.
 *
 * A chunk is a section: a heading plus the blocks under it, up to the next
 * heading. A section above the token cap splits at block boundaries; a single
 * block above the cap splits inside the block, and its parts share `block_id`
 * and count `part` up from 0. No chunk ever exceeds the cap, whatever the
 * block type: the embedding provider rejects oversized input and the page
 * would index as nothing.
 *
 * A token is estimated as four characters. The cap only has to keep a section
 * near the target and well under the provider's input limit.
 */
import { collectText, type BlockReferences, type ComarkNode } from '#shared/utils/comark-tree'
import { BLOCK_ID_PREFIX } from '#shared/page-blocks'

export interface Chunk {
  /** The block id of the chunk's first block — where a citation lands. */
  block_id: string
  /** Headings from the page's own down to the section's, outermost first. */
  heading_path: string[]
  /** 0 unless the chunk is one part of a block split inside. */
  part: number
  /** The raw text, as an excerpt shows it. Tables are one line per row: `Column: cell; Column: cell`. */
  text: string
  /** The sources the chunk's blocks cite, as `BlockReferences` writes an edge. */
  cites: string[]
  /** The pages the chunk's blocks link to, the same way. */
  links: string[]
}

export interface ChunkOptions {
  /** Tokens a chunk aims for. */
  targetTokens: number
  /** Tokens a chunk never exceeds. */
  maxTokens: number
}

/** The product defaults; Drupal ships the same numbers in openkb_search.settings. */
export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { targetTokens: 300, maxTokens: 500 }

/** A text's size in tokens, estimated as four characters each. */
export function countTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** What separates two blocks inside one chunk. */
const BLOCK_SEPARATOR = '\n\n'

/** No edges at all. */
const NO_REFERENCES: BlockReferences = { cites: [], links: [] }

/** One top-level block, as chunking reads it. */
interface Block {
  /** The block's own id, or '' where it carries none. */
  id: string
  /** 1 to 6 for a heading, 0 for anything else. */
  level: number
  text: string
}

/** A heading and the blocks below it, with the headings it sits under. */
interface Section {
  headingPath: string[]
  blocks: Block[]
}

/**
 * The page's sections, as the chunk index holds them.
 *
 * The whole tree, including the heading the page opens with: that heading is
 * the outermost entry of every `heading_path` under it, which is what gives a
 * chunk its place in the page.
 */
export function chunkDocument(
  nodes: ComarkNode[],
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
  references: Record<string, BlockReferences> = {},
): Chunk[] {
  const chunks: Chunk[] = []
  for (const section of sectionsOf(blocksOf(nodes, references))) {
    chunks.push(...chunkSection(section, options, references))
  }
  return chunks
}

/**
 * Every top-level block that has words or references, in document order.
 *
 * A block that is only a citation has no words, but it holds edges the chunk
 * it sits in must carry, so it joins that chunk without adding to its text.
 */
function blocksOf(nodes: ComarkNode[], references: Record<string, BlockReferences>): Block[] {
  const blocks: Block[] = []
  for (const node of nodes) {
    if (typeof node === 'string') continue
    const [tag, props] = node
    const text = blockText(node)
    const id = typeof props?.id === 'string' && props.id.startsWith(BLOCK_ID_PREFIX) ? props.id : ''
    if (text === '' && references[id] === undefined) continue
    blocks.push({ id, level: /^h([1-6])$/.test(tag) ? Number(tag[1]) : 0, text })
  }
  return blocks
}

/**
 * One block's text, as an excerpt shows it and as the embedding reads it.
 *
 * A list is one item per line and a table one row per line, so a row's cells
 * stay with their column names instead of embedding as a run of bare values.
 * Code keeps its own line breaks; everything else collapses to one line.
 */
function blockText(node: ComarkNode): string {
  if (typeof node === 'string') return node.replace(/\s+/g, ' ').trim()
  const [tag, , ...children] = node
  if (tag === 'table') return tableText(node)
  if (tag === 'ul' || tag === 'ol') return children.map(child => blockText(child)).filter(line => line !== '').join('\n')
  if (tag === 'pre') return collectText(children).replace(/\s+$/, '')
  return collectText(children).replace(/\s+/g, ' ').trim()
}

/** A table as one line per body row, `Column: cell; Column: cell`. */
function tableText(node: ComarkNode): string {
  const columns = rowsOf(node, 'thead')[0]?.map(cell => cell.replace(/:$/, '')) ?? []
  const lines: string[] = []
  for (const row of rowsOf(node, 'tbody')) {
    const cells = row.map((cell, i) => (columns[i] ? `${columns[i]}: ${cell}` : cell)).filter(cell => cell !== '')
    if (cells.length > 0) lines.push(cells.join('; '))
  }
  // A table with no body row still has its column names to say.
  return lines.length > 0 ? lines.join('\n') : columns.join('; ')
}

/** The cells of every row of one table part, cell text collapsed to a line. */
function rowsOf(node: ComarkNode, part: 'thead' | 'tbody'): string[][] {
  if (typeof node === 'string') return []
  const rows: string[][] = []
  for (const section of node.slice(2) as ComarkNode[]) {
    if (typeof section === 'string' || section[0] !== part) continue
    for (const row of section.slice(2) as ComarkNode[]) {
      if (typeof row === 'string' || row[0] !== 'tr') continue
      rows.push((row.slice(2) as ComarkNode[]).map(cell => blockText(cell)))
    }
  }
  return rows
}

/**
 * The blocks grouped into sections.
 *
 * A heading opens a section and closes the one before it, whatever its level,
 * so no two chunks hold the same words; where a chunk sits in the hierarchy is
 * what `heading_path` says. Blocks before the first heading are a section with
 * an empty path.
 */
function sectionsOf(blocks: Block[]): Section[] {
  const sections: Section[] = []
  const open: { level: number, text: string }[] = []
  let current: Section | undefined
  for (const block of blocks) {
    if (block.level === 0) {
      current ??= { headingPath: [], blocks: [] }
      current.blocks.push(block)
      continue
    }
    while (open.length > 0 && open[open.length - 1]!.level >= block.level) open.pop()
    open.push({ level: block.level, text: block.text })
    if (current) sections.push(current)
    current = { headingPath: open.map(entry => entry.text), blocks: [block] }
  }
  if (current) sections.push(current)
  return sections
}

/**
 * One section as the chunks it fits into.
 *
 * A block joins the open chunk unless that would carry it further past the
 * target than closing here falls short of it, so a chunk lands as near the
 * target as its blocks allow and every part still opens on a block of its own.
 * The cap is measured on the text a chunk actually carries: joining two blocks
 * costs tokens of its own, which a count per block would miss.
 */
function chunkSection(section: Section, options: ChunkOptions, references: Record<string, BlockReferences>): Chunk[] {
  const chunks: Chunk[] = []
  const textOf = (blocks: Block[]): string =>
    blocks.map(block => block.text).filter(text => text !== '').join(BLOCK_SEPARATOR)

  let open: Block[] = []
  let openTokens = 0
  // The edges of blocks with no words of their own, held until a chunk with
  // words takes them. A section with no words at all indexes nothing, so it
  // has nowhere to put them.
  let carried = NO_REFERENCES
  const close = (): void => {
    if (open.length > 0) {
      const text = textOf(open)
      const refs = merged([carried, referencesOf(open, references)])
      carried = text === '' ? refs : NO_REFERENCES
      if (text !== '') chunks.push(chunk(section, open[0]!.id, 0, text, refs))
    }
    open = []
    openTokens = 0
  }

  for (const block of section.blocks) {
    const blockTokens = countTokens(block.text)
    if (blockTokens > options.maxTokens) {
      close()
      const refs = merged([carried, referencesOf([block], references)])
      carried = NO_REFERENCES
      splitToCap(block.text, options).forEach((text, part) => chunks.push(chunk(section, block.id, part, text, refs)))
      continue
    }
    if (open.length > 0) {
      const joined = countTokens(textOf([...open, block]))
      if (joined > options.maxTokens || overshoots(openTokens, joined, options.targetTokens)) close()
    }
    open.push(block)
    openTokens = open.length === 1 ? blockTokens : countTokens(textOf(open))
  }
  close()
  // A section ending on words-less blocks leaves their edges with its last chunk.
  const last = chunks[chunks.length - 1]
  if (last && (carried.cites.length > 0 || carried.links.length > 0)) {
    Object.assign(last, merged([carried, last]))
  }
  return chunks
}

/** Whether growing to `joined` misses the target by more than stopping at `open` does. */
function overshoots(open: number, joined: number, target: number): boolean {
  return joined > target && joined - target > target - open
}

function chunk(section: Section, blockId: string, part: number, text: string, references: BlockReferences): Chunk {
  return { block_id: blockId, heading_path: section.headingPath, part, text, ...references }
}

/**
 * What the blocks of one chunk reference, once each.
 *
 * A chunk holds one or more whole blocks, so it carries what all of them
 * reference; a block split into parts puts the same references on each part.
 */
function referencesOf(blocks: Block[], references: Record<string, BlockReferences>): BlockReferences {
  return merged(blocks.map(block => references[block.id] ?? NO_REFERENCES))
}

/** Several reference sets as one, each edge once. */
function merged(sets: BlockReferences[]): BlockReferences {
  return {
    cites: [...new Set(sets.flatMap(set => set.cites))],
    links: [...new Set(sets.flatMap(set => set.links))],
  }
}

/**
 * One oversized block as parts, none of them above the cap.
 *
 * The block is cut at the coarsest boundary that fits — line, then sentence,
 * then word, then bare characters for a single token run longer than the cap —
 * so a part reads as the text it came from wherever the text allows it.
 */
function splitToCap(text: string, options: ChunkOptions): string[] {
  const parts: string[] = []
  let open = ''
  let openTokens = 0
  for (const atom of atoms(text, options.maxTokens)) {
    if (open !== '') {
      const joined = countTokens(`${open}\n${atom}`)
      if (joined > options.maxTokens || overshoots(openTokens, joined, options.targetTokens)) {
        parts.push(open)
        open = ''
        openTokens = 0
      }
    }
    open = open === '' ? atom : `${open}\n${atom}`
    openTokens = countTokens(open)
  }
  if (open !== '') parts.push(open)
  return parts
}

/** The block's text as pieces that each fit the cap on their own. */
function atoms(text: string, max: number): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    if (countTokens(line) <= max) {
      out.push(line)
      continue
    }
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      if (countTokens(sentence) <= max) {
        out.push(sentence)
        continue
      }
      out.push(...words(sentence, max))
    }
  }
  return out
}

/** A sentence over the cap, as runs of whole words — or of characters. */
function words(sentence: string, max: number): string[] {
  const out: string[] = []
  let open = ''
  for (const word of sentence.split(/\s+/)) {
    if (word === '') continue
    if (countTokens(word) > max) {
      if (open !== '') out.push(open)
      open = ''
      out.push(...characters(word, max))
      continue
    }
    const joined = open === '' ? word : `${open} ${word}`
    if (open !== '' && countTokens(joined) > max) {
      out.push(open)
      open = word
    }
    else {
      open = joined
    }
  }
  if (open !== '') out.push(open)
  return out
}

/** A single word over the cap — a data URI, a hash — cut by code point. */
function characters(word: string, max: number): string[] {
  const points = [...word]
  const out: string[] = []
  let taken = 0
  while (taken < points.length) {
    // A token spans at least one code point, so the cap is never reached
    // before the slice is at least that long.
    let size = Math.max(1, Math.min(points.length - taken, max))
    while (size > 1 && countTokens(points.slice(taken, taken + size).join('')) > max) size -= 1
    out.push(points.slice(taken, taken + size).join(''))
    taken += size
  }
  return out
}

