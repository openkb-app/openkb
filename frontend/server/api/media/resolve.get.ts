import { defineEventHandler, getQuery, createError } from 'h3'
import { resolveMediaUuids } from '../../utils/media'
import { forwardedAuthHeaders } from '../../utils/actor'
import { MEDIA_UUID_RE } from '#shared/utils/media'

/**
 * Client-facing endpoint over {@link resolveMediaUuids}: the editor's
 * ImageNodeView and a chat answer resolve `media` attrs to display URLs
 * through it. The read path resolves server-side in the CE enrichment.
 */

export default defineEventHandler(async (event) => {
  const raw = String(getQuery(event).uuids ?? '').trim()
  if (!raw) return { items: {} }

  const uuids = [...new Set(raw.split(','))].map(u => u.trim())
  if (uuids.length > 50) {
    throw createError({ statusCode: 400, statusMessage: 'Too many UUIDs (max 50)' })
  }
  if (!uuids.every(u => MEDIA_UUID_RE.test(u))) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid media UUID' })
  }

  return { items: await resolveMediaUuids(forwardedAuthHeaders(event), uuids) }
})
