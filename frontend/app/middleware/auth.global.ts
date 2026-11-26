// Global auth guard. Anonymous users see nothing — every route except
// /access-denied + the sign-in pages redirects them to /access-denied. Detection
// is whatever Drupal session cookies are present in the request:
//   - SSR: the incoming Request's Cookie header (useCookie picks them up)
//   - Client nav: useCookie reads document.cookie for the SameSite-aware
//     cookies the browser has stored
// HttpOnly cookies can be read by useCookie on the server but NOT by
// document.cookie on the client. That's fine — for client-side route
// changes the user has already passed the SSR check on initial load.
// /oauth/authorize is the browser leg of the OAuth flow. It is reached with
// no session on purpose — Drupal answers an anonymous arrival by sending the
// visitor to the login page with a destination back here, and the guard would
// eat that before it happened.
const ANON_ROUTES = new Set(['/access-denied', '/user/login', '/user/password', '/oauth/authorize'])

// The one-time login link: the invitee's, or a password reset's.
const ONE_TIME_LOGIN = /^\/user\/reset\//

// A Drupal session cookie; Drupal hashes its name from the cookie domain.
const SESSION_COOKIE = /(?:^|;\s*)S?SESS[a-z0-9]+=/i

/**
 * Whether the request carries a Drupal session cookie, or is the page
 * export's render of the read page (with an agent's token, too).
 *
 * - SSR: matches the raw Cookie header, or the export render's carrier
 *   (server/utils/export-render.ts).
 * - Client: always true; the initial SSR already gated the visitor.
 */
function hasSessionCookieOrIsExportRender(): boolean {
  if (import.meta.server) {
    const raw = useRequestEvent()?.node?.req?.headers?.cookie ?? ''
    return SESSION_COOKIE.test(raw) || Object.keys(useExportRenderAuthHeaders()).length > 0
  }
  // Client. document.cookie omits HttpOnly cookies — so on a client-only
  // navigation we have to assume the initial SSR already let the user
  // through. Don't re-gate on the client.
  return true
}

/**
 * Sends a visitor without a session to /access-denied, except on the sign-in
 * pages and the one-time login link.
 */
export default defineNuxtRouteMiddleware((to) => {
  if (ANON_ROUTES.has(to.path) || ONE_TIME_LOGIN.test(to.path)) {
    return
  }
  if (!hasSessionCookieOrIsExportRender()) {
    return navigateTo({ path: '/access-denied', query: { from: to.fullPath } })
  }
})
