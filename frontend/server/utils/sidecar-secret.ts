import { createHmac, timingSafeEqual } from 'node:crypto'
import { createError, getHeader, type H3Event } from 'h3'

/** The header Drupal's comark module sends the key in. */
export const SIDECAR_SECRET_HEADER = 'x-comark-secret'

/** What the key is derived for; Drupal's `SidecarSecret` uses the same label. */
const SIDECAR_KEY_LABEL = 'comark-sidecar'

/** The key the internal comark routes take: an HMAC of the label under the collaboration client's secret. */
export function sidecarKey(secret: string): string {
  return createHmac('sha256', secret).update(SIDECAR_KEY_LABEL).digest('hex')
}

/**
 * Refuses a call to an internal comark route that does not carry the key
 * derived from the collaboration client's secret, which Drupal and the
 * frontend both hold.
 */
export function requireSidecarSecret(event: H3Event): void {
  const secret = process.env.OKB_COLLAB_CLIENT_SECRET ?? ''
  if (secret === '') {
    throw createError({ statusCode: 503, statusMessage: 'No OKB_COLLAB_CLIENT_SECRET: internal comark routes are off' })
  }
  const given = Buffer.from(getHeader(event, SIDECAR_SECRET_HEADER) ?? '')
  const wanted = Buffer.from(sidecarKey(secret))
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    throw createError({ statusCode: 401, statusMessage: 'Missing or wrong sidecar secret' })
  }
}
