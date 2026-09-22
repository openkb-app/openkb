import { defineEventHandler, readBody, createError } from 'h3'
import { markdownToIndexable } from '../../utils/comark-indexable'
import { DEFAULT_CHUNK_OPTIONS, type ChunkOptions } from '../../utils/comark-chunks'
import { bodyAllowedHtml } from '../../utils/comark-allowed-html'

/**
 * Called by Drupal's ComarkIndexable search_api processor at index time.
 *
 *   POST /api/comark/indexable   { "markdown": "…", "chunkOptions": {…} }
 *
 * Returns { chunks } — one section per row of the chunk index, cut by the
 * same tree passes that render the read page.
 *
 * `chunkOptions` carries the token target and cap, which Drupal owns
 * (`openkb_search.settings`) because the strategy that embeds the chunks is
 * configured there. The defaults below only answer a caller that names none.
 *
 * No auth, no JSON:API — Drupal already has the markdown and passes it in
 * the request body. The Nuxt sidecar runs in the same docker container
 * (pm2 on web:3000), so the call is intra-container.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<{ markdown?: string, chunkOptions?: Partial<ChunkOptions> }>(event)
  if (typeof body?.markdown !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'Missing markdown' })
  }
  return markdownToIndexable(body.markdown, await bodyAllowedHtml(), chunkOptions(body.chunkOptions))
})

/** The caller's token target and cap, each falling back to the default. */
function chunkOptions(asked?: Partial<ChunkOptions>): ChunkOptions {
  return {
    targetTokens: positive(asked?.targetTokens) ?? DEFAULT_CHUNK_OPTIONS.targetTokens,
    maxTokens: positive(asked?.maxTokens) ?? DEFAULT_CHUNK_OPTIONS.maxTokens,
  }
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}
