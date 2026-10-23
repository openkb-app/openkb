/**
 * A page file (ADR 0020) as an embed renders it: `::attachment{file}` and
 * `::image{file}`. Resolved per reader, so a file the reader may not download
 * is absent and the embed shows a placeholder.
 */
export interface ResolvedFile {
  /** Download URL on Drupal's private-file route. */
  url: string
  name: string
  /** Bytes. */
  size: number
  mime: string
  /** Uploader's display name, where the reader may see it. */
  owner: string | null
  /** ISO date of the upload. */
  created: string | null
}

/**
 * The URL that downloads a file: Drupal answers `?download` with an
 * attachment. The `download` attribute alone does nothing cross-origin.
 */
export function fileDownloadUrl(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}download`
}

/** One entry of the read page's attachments list. */
export interface PageAttachment extends ResolvedFile {
  id: string
  /** The `description` of the file's first `::attachment` embed. */
  description?: string | null
}

/** One entry of the "my files" picker. */
export interface MyFile extends PageAttachment {
  /** Titles of the readable pages whose current revision holds the file. */
  usedOn: string[]
}

/** The page's two file fields, keyed by their `fields` Y.Map key. */
export const PAGE_FILE_FIELDS = {
  attachments: 'field_kb_attachments',
  images: 'field_kb_images',
} as const

export type PageFileKey = keyof typeof PAGE_FILE_FIELDS

/** A file field's upload limits, as Drupal checks them. */
export interface PageFileLimits {
  extensions: string[]
  maxBytes: number
}

/** What `GET /openkb/schema` publishes under `files`, keyed by field name. */
export type PageFileLimitsByField = Record<string, PageFileLimits | undefined>

/** The `accept` of a file input for `limits`; any file without a list. */
export function fileAccept(limits: PageFileLimits | undefined): string | undefined {
  return limits?.extensions.length ? limits.extensions.map(extension => `.${extension}`).join(',') : undefined
}

/** The file types `::embed{file}` shows in a frame: extension → MIME type. */
export const EMBED_MIMES = { html: 'text/html', pdf: 'application/pdf' } as const

export type EmbedKind = keyof typeof EMBED_MIMES

/** How `::embed` shows a file of `mime`: a frame kind, or null for the file card. */
export function embedKind(mime: string | undefined): EmbedKind | null {
  const type = (mime ?? '').toLowerCase().split(';')[0]!.trim()
  return (Object.keys(EMBED_MIMES) as EmbedKind[]).find(kind => EMBED_MIMES[kind] === type) ?? null
}

/** The smallest height an HTML embed frame takes. */
export const EMBED_MIN_HEIGHT = 80

/**
 * The height an HTML embed frame takes from `message`, or null to ignore it:
 * - sent by `frame` itself;
 * - `{ type: 'okb-embed:height', height }` with a finite number;
 * - clamped to EMBED_MIN_HEIGHT…`viewport`.
 */
export function embedFrameHeight(message: Pick<MessageEvent, 'source' | 'data'>, frame: unknown, viewport: number): number | null {
  if (!frame || message.source !== frame) return null
  const data = message.data as { type?: unknown, height?: unknown } | null
  if (data?.type !== 'okb-embed:height' || typeof data.height !== 'number' || !Number.isFinite(data.height)) return null
  return Math.round(Math.min(Math.max(data.height, EMBED_MIN_HEIGHT), viewport))
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A file UUID, as the resolve and upload routes accept it. */
export function isFileUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

const UNITS = ['B', 'KB', 'MB', 'GB'] as const

/** A byte count for people: `48.2 KB`. Empty for a value that is not one. */
export function formatFileSize(size: unknown): string {
  const bytes = Number(size)
  if (size === null || size === undefined || size === '' || !Number.isFinite(bytes) || bytes < 0) return ''
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${UNITS[unit]}`
}

/** The Lucide icon a MIME type shows as on the file card. */
export function fileIcon(mime: string | undefined): string {
  const type = (mime ?? '').toLowerCase()
  if (type.startsWith('image/')) return 'i-lucide-file-image'
  if (type.includes('spreadsheet') || type === 'text/csv') return 'i-lucide-file-spreadsheet'
  if (type === 'text/html') return 'i-lucide-file-code'
  if (type === 'application/pdf' || type.startsWith('text/')) return 'i-lucide-file-text'
  if (type.includes('presentation')) return 'i-lucide-presentation'
  if (type.includes('zip')) return 'i-lucide-file-archive'
  return 'i-lucide-file'
}

/**
 * The file among `files` that `href` downloads, matched by path: a link may
 * name the Drupal host, the frontend's, or none.
 */
export function pageFileForUrl<T extends { url: string }>(href: string, files: T[]): T | null {
  const path = (url: string): string | null => {
    try {
      return decodeURIComponent(new URL(url, 'http://local.invalid').pathname)
    }
    catch {
      return null
    }
  }
  const wanted = path(href.trim())
  if (!wanted?.startsWith('/system/files/')) return null
  return files.find(file => path(file.url) === wanted) ?? null
}
