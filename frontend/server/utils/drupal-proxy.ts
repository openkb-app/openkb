import type { H3Event } from 'h3'
import { proxyRequest, getRequestURL, createError } from 'h3'

/**
 * Same-origin passthrough to Drupal for the media-library dialog.
 *
 * Drupal's dialog JS (loaded from the openkb_media_library CE route)
 * requests root-relative paths on the current origin — dialog content,
 * form submits, views AJAX, and the CSS/JS/derivative assets those
 * responses reference. The routes in server/routes/ forward exactly those
 * paths here; proxying keeps Drupal's JS unmodified (no CORS, no CSP).
 * Cookies pass through, so Drupal sees the shared session — the same auth
 * model as server/utils/drupal.ts.
 *
 * The POST paths (/media-library, /views/ajax and the media-widget view the
 * Grid/Table links lead to) are also listed in drupalCe.disableFormHandler
 * (nuxt.config.ts): nuxtjs-drupal-ce's global form-handler middleware would
 * otherwise consume every urlencoded or multipart POST body before this proxy
 * sees it.
 */
export function proxyToDrupal(event: H3Event) {
  const base = (useRuntimeConfig().drupalBaseUrl as string).replace(/\/$/, '')
  const url = getRequestURL(event)
  return proxyRequest(event, `${base}${url.pathname}${url.search}`)
}

/**
 * Static-asset variant for the /core, /files, /modules, /sites and /themes
 * prefixes: the dialog only needs CSS/JS/fonts/images from those paths, so
 * anything else — /core/install.php and friends — is rejected instead of
 * exposing Drupal's PHP entry points on the app origin.
 */
const STATIC_ASSET_EXT = /\.(?:css|js|mjs|map|json|woff2?|ttf|eot|otf|svg|png|jpe?g|gif|webp|avif|ico)$/i

export function proxyStaticAsset(event: H3Event) {
  const url = getRequestURL(event)
  if (!STATIC_ASSET_EXT.test(url.pathname)) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }
  return proxyToDrupal(event)
}
