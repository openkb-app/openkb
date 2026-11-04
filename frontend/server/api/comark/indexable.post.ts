import { defineEventHandler, createError } from 'h3'
import { markdownToIndexable } from '../../utils/comark-indexable'
import { DEFAULT_CHUNK_OPTIONS, type ChunkOptions } from '../../utils/comark-chunks'
import { bodyAllowedHtml } from '../../utils/comark-allowed-html'
import { readCappedBody } from '../../utils/capped-body'
import { requireSidecarSecret } from '../../utils/sidecar-secret'

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
 * No JSON:API — Drupal already has the markdown and passes it in the request
 * body, with the key derived from the shared secret (`requireSidecarSecret`).
 *
 * The route is reachable from outside, so a body over {@link MAX_BODY_BYTES}
 * is a 413. The cap leaves room for `data:` images in a page.
 */
export const MAX_BODY_BYTES = 8 * 1024 * 1024

export default defineEventHandler(async (event) => {
  requireSidecarSecret(event)
  const raw = await readCappedBody(event, MAX_BODY_BYTES)
  let body: { markdown?: string, chunkOptions?: Partial<ChunkOptions> } | undefined
  try {
    body = raw.byteLength > 0 ? JSON.parse(raw.toString('utf8')) : undefined
  }
  catch {
    throw createError({ statusCode: 400, statusMessage: 'Invalid JSON body' })
  }
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

/** The value when it is a positive integer. */
function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}
