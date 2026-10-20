import { defineEventHandler, getQuery, createError, type H3Event } from 'h3'
import { DrupalJsonApiParams } from 'drupal-jsonapi-params'
import { drupalFetch, publicDrupalBaseUrl } from '../../utils/drupal'
import type { MyFile } from '#shared/utils/files'

/**
 * GET /api/files/mine?images=1  →  the caller's own uploads, newest first, for
 * the editor's "my files" picker (ADR 0020): picking one adds that same file
 * to the page. Another person's file is never listed. `images` narrows the
 * list to images, for the image action. Each file names the pages using it.
 */

/** How many files the picker lists. */
const LIMIT = 50

interface JsonApiFiles {
  data?: Array<{
    id: string
    attributes?: { filename?: string, filesize?: number, filemime?: string, created?: string, uri?: { url?: string } }
  }>
}

interface JsonApiPages {
  data?: Array<{
    attributes?: { title?: string }
    relationships?: Record<string, { data?: Array<{ id: string }> | null }>
  }>
}

/**
 * Page titles per file UUID, from the pages the caller may read. One request
 * per field: in an OR group, JSON:API's file access condition on the empty
 * field drops the page.
 */
async function pagesUsing(event: H3Event, ids: string[]): Promise<Map<string, string[]>> {
  const used = new Map<string, Set<string>>()
  await Promise.all(['field_kb_attachments', 'field_kb_images'].map(async (field) => {
    const params = new DrupalJsonApiParams()
      .addFilter(`${field}.id`, ids, 'IN')
      .addFields('node--kb_page', ['title', field])
      .addPageLimit(LIMIT)
    const doc = await drupalFetch<JsonApiPages>(event, `/jsonapi/node/kb_page?${params.getQueryString()}`)
    for (const page of doc.data ?? []) {
      for (const ref of page.relationships?.[field]?.data ?? []) {
        used.set(ref.id, (used.get(ref.id) ?? new Set()).add(page.attributes?.title ?? ''))
      }
    }
  }))
  return new Map([...used].map(([id, titles]) => [id, [...titles]]))
}

export default defineEventHandler(async (event): Promise<{ items: MyFile[] }> => {
  const root = await drupalFetch<{ meta?: { links?: { me?: { meta?: { id?: string } } } } }>(event, '/jsonapi')
  const me = root.meta?.links?.me?.meta?.id
  if (!me) throw createError({ statusCode: 401, statusMessage: 'Authentication required' })

  const params = new DrupalJsonApiParams()
    .addFilter('uid.id', me)
    .addFields('file--file', ['filename', 'filesize', 'filemime', 'created', 'uri'])
    .addSort('created', 'DESC')
    .addPageLimit(LIMIT)
  if (getQuery(event).images) params.addFilter('filemime', 'image/', 'STARTS_WITH')

  const doc = await drupalFetch<JsonApiFiles>(event, `/jsonapi/file/file?${params.getQueryString()}`)
  const files = doc.data ?? []
  const used = files.length ? await pagesUsing(event, files.map(file => file.id)) : new Map<string, string[]>()
  return {
    items: files.flatMap((file) => {
      const url = file.attributes?.uri?.url
      if (typeof url !== 'string') return []
      return [{
        id: file.id,
        url: url.startsWith('/') ? `${publicDrupalBaseUrl()}${url}` : url,
        name: file.attributes?.filename ?? '',
        size: file.attributes?.filesize ?? 0,
        mime: file.attributes?.filemime ?? '',
        owner: null,
        created: file.attributes?.created ?? null,
        usedOn: used.get(file.id) ?? [],
      }]
    }),
  }
})
