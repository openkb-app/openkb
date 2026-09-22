// The consent screen is a single question to answer, not a page of this app:
// it carries no navigation to wander off into mid-authorization. Everything
// else the catch-all serves keeps the full chrome, so the layout is set here
// rather than owned by the page — a page that switches the layout itself
// remounts the chrome, and with it the chat drawer's live conversation.
export default defineNuxtRouteMiddleware((to) => {
  if (to.path === '/oauth/authorize') setPageLayout('bare')
})
