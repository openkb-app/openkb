// Pages that are a single question to answer, not pages of this app: they
// carry no navigation to wander off into. Everything else the catch-all serves
// keeps the full chrome, so the layout is set here rather than owned by the
// page — a page that switches the layout itself remounts the chrome, and with
// it the chat drawer's live conversation.
const BARE_PATHS = new Set(['/oauth/authorize', '/user/login', '/user/password'])

// The one-time login, the password form it leads to, and the invite's accept page.
const BARE_PATTERNS = [/^\/user\/reset\//, /^\/user\/\d+\/edit$/, /^\/invite\/\d+$/]

/** Whether the path is a page answered on a bare card. */
function isBarePath(path: string): boolean {
  return BARE_PATHS.has(path) || BARE_PATTERNS.some(pattern => pattern.test(path))
}

/**
 * Sets the bare layout on the pages answered on a bare card.
 */
export default defineNuxtRouteMiddleware((to) => {
  if (isBarePath(to.path)) {
    setPageLayout('bare')
  }
})
