import { DrupalJsonApiParams } from 'drupal-jsonapi-params'
import { drupalFetchWithAuth, publicDrupalBaseUrl } from './drupal'
import type { ResolvedMedia } from '#shared/utils/media'

/**
 * Batch media-UUID → render-URL resolution for `::image{media="…"}`
 * embeds. The stored markdown carries only the media UUID; whoever
 * renders it (the editor NodeView via /api/media/resolve, the read-path
 * CE enrichment) resolves URLs here at render time.
 *
 * Resolves `image` media via JSON:API with the image file included; the
 * request's auth carrier (session cookie or agent Bearer token) is forwarded
 * so access respects per-role permissions. Unknown / inaccessible UUIDs are
 * simply absent from the result — the caller decides how to render a hole.
 */

interface JsonApiMediaDoc {
  data?: Array<{
    id: string
    relationships?: {
      field_media_image?: {
        data?: { id?: string, meta?: { alt?: string, width?: number, height?: number } } | null
      }
    }
  }>
  included?: Array<{
    id: string
    attributes?: { uri?: { url?: string } }
  }>
}

export async function resolveMediaUuids(
  auth: Record<string, string>,
  uuids: string[],
): Promise<Record<string, ResolvedMedia>> {
  if (uuids.length === 0) return {}

  const params = new DrupalJsonApiParams()
    .addFilter('id', uuids, 'IN')
    .addInclude(['field_media_image'])
    .addFields('media--image', ['field_media_image'])
    .addFields('file--file', ['uri'])

  const doc = await drupalFetchWithAuth<JsonApiMediaDoc>(
    auth,
    `/jsonapi/media/image?${params.getQueryString()}`,
  )

  // JSON:API file URLs are root-relative to Drupal; the browser loads them
  // from the Drupal vhost, not the Nuxt one, so absolutize here.
  const fileUrls = new Map<string, string>()
  for (const file of doc.included ?? []) {
    const url = file.attributes?.uri?.url
    if (typeof url === 'string') {
      fileUrls.set(file.id, url.startsWith('/') ? `${publicDrupalBaseUrl()}${url}` : url)
    }
  }

  const items: Record<string, ResolvedMedia> = {}
  for (const media of doc.data ?? []) {
    const ref = media.relationships?.field_media_image?.data
    const url = ref?.id ? fileUrls.get(ref.id) : undefined
    if (!url) continue
    items[media.id] = {
      url,
      alt: ref?.meta?.alt ?? '',
      width: ref?.meta?.width ?? null,
      height: ref?.meta?.height ?? null,
    }
  }
  return items
}
