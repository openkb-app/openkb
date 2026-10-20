import type { IncomingMessage } from 'node:http'
import { defineEventHandler, getQuery, getHeader, createError } from 'h3'
import { fetchFrontmatterSchema, uploadPageFileWithAuth } from '../../utils/drupal'
import { forwardedAuthHeaders } from '../../utils/actor'
import { PAGE_FILE_FIELDS, type PageFileKey } from '#shared/utils/files'

/**
 * Uploads one page file (ADR 0020) to core's JSON:API file upload for
 * `?field=attachments|images`, under the caller's own session or token.
 * - Name from `Content-Disposition: file; filename="…"`.
 * - A body over the field's size limit (`files` on `GET /openkb/schema`) is
 *   cut off with 413: Drupal checks the size only once it has written the
 *   whole file. The connection closes after the answer.
 * - The body is read as Drupal takes it, so a slow upstream holds no more
 *   than a chunk in memory.
 * - Drupal's extension and size refusals pass through as 413 / 422.
 *
 * Answers the new file's UUID.
 */

/** `filename="…"` out of a Content-Disposition header. */
const FILENAME = /filename\s*=\s*"((?:[^"\\]|\\.)*)"|filename\s*=\s*([^;\s]+)/i

/** The base name a client sent, percent-decoded where it encoded one. */
function fileName(raw: string): string {
  const unescaped = raw.replace(/\\(.)/g, '$1')
  let decoded = unescaped
  try {
    decoded = decodeURIComponent(unescaped)
  }
  catch { /* not percent-encoded */ }
  return decoded.split(/[\\/]/).pop()?.trim() ?? ''
}

export default defineEventHandler(async (event) => {
  const key = String(getQuery(event).field ?? '')
  if (!Object.hasOwn(PAGE_FILE_FIELDS, key)) {
    throw createError({ statusCode: 400, statusMessage: 'Unknown file field' })
  }
  const auth = forwardedAuthHeaders(event)
  if (Object.keys(auth).length === 0) {
    throw createError({ statusCode: 401, statusMessage: 'Authentication required' })
  }
  const match = FILENAME.exec(getHeader(event, 'content-disposition') ?? '')
  const raw = match?.[1] ?? match?.[2]
  const name = raw ? fileName(raw) : ''
  if (!name) {
    throw createError({ statusCode: 400, statusMessage: 'A file name is required' })
  }
  const field = PAGE_FILE_FIELDS[key as PageFileKey]
  const limit = (await fetchFrontmatterSchema(event)).files?.[field]?.maxBytes ?? Infinity
  if (Number(getHeader(event, 'content-length')) > limit) throw tooLarge()
  const body = cappedBody(event.node.req, limit)
  try {
    return await uploadPageFileWithAuth(auth, field, name, body.stream)
  }
  catch (error) {
    await body.discard()
    if (!body.tooLarge()) throw error
    event.node.res.setHeader('Connection', 'close')
    throw tooLarge()
  }
})

/** How long the rest of an oversized body is read and discarded before the 413. */
const DISCARD_MS = 10_000

/**
 * The request body as a pull stream that errors past `limit` bytes.
 * - Read one chunk per pull, so memory holds no more than a chunk.
 * - `discard()` reads the rest and drops it: closing on an unread body resets
 *   the connection before the client reads the answer.
 */
function cappedBody(req: IncomingMessage, limit: number) {
  let received = 0
  let discarding: Promise<void> | null = null
  const discard = () => discarding ??= new Promise<void>((resolve) => {
    if (req.readableEnded || req.destroyed) return resolve()
    const timer = setTimeout(resolve, DISCARD_MS)
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    req.once('end', done)
    req.once('close', done)
    req.resume()
  })
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      req.pause()
      req.on('data', (chunk: Uint8Array) => {
        if (discarding) return
        received += chunk.byteLength
        if (received > limit) {
          discard()
          return controller.error(tooLarge())
        }
        controller.enqueue(new Uint8Array(chunk))
        req.pause()
      })
      req.once('end', () => discarding || controller.close())
      req.once('error', error => discarding || controller.error(error))
    },
    pull() {
      req.resume()
    },
    cancel() {
      discard()
    },
  }, { highWaterMark: 0 })
  return { stream, discard, tooLarge: () => received > limit }
}

function tooLarge() {
  return createError({ statusCode: 413, statusMessage: 'The file is too large' })
}
