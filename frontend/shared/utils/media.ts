/**
 * A media UUID resolved to what an `::image{media="…"}` embed renders with.
 * Shared because both sides of the resolve produce it: the server route
 * (`server/utils/media.ts`, over JSON:API) and every caller that hands the
 * comark tree passes a resolver.
 */
export interface ResolvedMedia {
  url: string
  alt: string
  width: number | null
  height: number | null
}

/**
 * A media UUID as the resolve route accepts it. Callers filter on this before
 * asking: a chat answer re-walks on every streamed delta, so an `::image`
 * fence is repeatedly seen with half its id typed.
 */
export const MEDIA_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
