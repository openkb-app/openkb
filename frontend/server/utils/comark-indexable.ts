/**
 * The page body as the search indexer wants it: the sections the chunk
 * index holds one row each of (`comark-chunks.ts`).
 *
 * The index holds what the read page renders, so it is filtered by the same
 * text-format allowed list the caller hands the read path. The tree is the
 * reader-independent one: no media, no doc resolution, no block links, so the
 * index holds the page's words and not its chrome.
 *
 * Each chunk also carries what its blocks reference — the sources they cite
 * and the pages they link to — read off the parsed tree, where those nodes
 * still are.
 */
import { cleanTree, parseComark, referencesByBlock, type AllowedHtml } from '#shared/utils/comark-tree'
import { chunkDocument, DEFAULT_CHUNK_OPTIONS, type Chunk, type ChunkOptions } from './comark-chunks'

export interface IndexableDoc {
  /** One per section, for the chunk index the semantic arm reads. */
  chunks: Chunk[]
}

export async function markdownToIndexable(
  markdown: string,
  allowedHtml?: AllowedHtml,
  chunkOptions: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): Promise<IndexableDoc> {
  const parsed = await parseComark(markdown)
  const nodes = await cleanTree(parsed, { allowedHtml })
  // The whole document, the page's own heading included: that heading is the
  // outermost entry of every chunk's `heading_path`.
  return { chunks: nodes.length === 0 ? [] : chunkDocument(nodes, chunkOptions, referencesByBlock(parsed)) }
}
