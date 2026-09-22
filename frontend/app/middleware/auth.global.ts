// Global auth guard. Anonymous users see nothing — every route except
// /access-denied + /user/login redirects them to /access-denied. Detection
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
const ANON_ROUTES = new Set(['/access-denied', '/user/login', '/oauth/authorize'])

function hasSessionCookie(): boolean {
  // useCookie returns a Ref; the value is populated from the request
  // headers on SSR and from document.cookie on the client. We don't
  // know the exact session-cookie name (Drupal hashes it from the
  // cookie_domain), so probe a handful of likely names by reading
  // the raw header on SSR and falling back to document.cookie.
  if (import.meta.server) {
    const event = useRequestEvent()
    const raw = event?.node?.req?.headers?.cookie ?? ''
    return /(?:^|;\s*)S?SESS[a-z0-9]+=/i.test(raw)
  }
  // Client. document.cookie omits HttpOnly cookies — so on a client-only
  // navigation we have to assume the initial SSR already let the user
  // through. Don't re-gate on the client.
  return true
}

export default defineNuxtRouteMiddleware((to) => {
  if (ANON_ROUTES.has(to.path)) return
  if (!hasSessionCookie()) {
    return navigateTo({ path: '/access-denied', query: { from: to.fullPath } })
  }
})
