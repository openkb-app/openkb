import { defineEventHandler, getQuery, createError } from 'h3'
import { resolveFileUuids } from '../../utils/files'
import { forwardedAuthHeaders } from '../../utils/actor'
import { isFileUuid } from '#shared/utils/files'

/**
 * Client-facing endpoint over {@link resolveFileUuids}: the editor's file and
 * image node views and a chat answer resolve `file` attrs through it. The
 * read path resolves server-side in the CE enrichment.
 */
export default defineEventHandler(async (event) => {
  const raw = String(getQuery(event).uuids ?? '').trim()
  if (!raw) return { items: {} }

  const uuids = [...new Set(raw.split(',').map(u => u.trim()))]
  if (uuids.length > 50) {
    throw createError({ statusCode: 400, statusMessage: 'Too many UUIDs (max 50)' })
  }
  if (!uuids.every(isFileUuid)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid file UUID' })
  }

  return { items: await resolveFileUuids(forwardedAuthHeaders(event), uuids) }
})
