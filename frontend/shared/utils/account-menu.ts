/**
 * Drupal's `account` menu, as the chrome's user menu renders it.
 *
 * The items are Drupal's, not this app's: `useDrupalCe().fetchMenu('account')`
 * reads them from rest_menu_items (lupus_decoupled_menu), which is what the
 * Lupus Decoupled starter's account navigation does. Core's
 * `LoginLogoutMenuLink` is what makes one link say "Log in" for an anonymous
 * session and "Log out" for a signed-in one, so the signed-out state needs no
 * branch here either.
 */

/** One item as rest_menu_items serialises it. Only the read fields are named. */
export interface AccountMenuItem {
  /** Menu link plugin id — `user.login`, `user.logout`, `user.page`, … */
  key: string
  title: string
  /**
   * Path on this origin, route-processed. The session-bound CSRF token
   * `user.logout` requires is in *this* field and not in `uri`/`alias`, which
   * are built from the raw path and carry no query.
   */
  relative: string
  enabled: boolean
}

/**
 * Items the app can actually deliver on, in the order Drupal sent them.
 *
 * Disabled links are dropped, as they would be in Drupal's own rendering.
 * Everything else Drupal puts in the menu is rendered as-is, `user.page`
 * included — `/user/<uid>` is a page of this frontend (`UserProfile`) — so an
 * item added on the Drupal side shows up here without a code change.
 */
export function renderableAccountItems(
  items: readonly AccountMenuItem[] | null | undefined,
): AccountMenuItem[] {
  return (items ?? []).filter(item => item.enabled !== false)
}

/**
 * The icon for a menu item, read off where the link goes rather than off its
 * title (translated) or its key (`LoginLogoutMenuLink` keeps the id
 * `user.logout` while pointing at the *login* route for an anonymous session).
 */
export function accountItemIcon(item: AccountMenuItem): string {
  const path = item.relative.split('?')[0] ?? ''
  if (path.startsWith('/user/logout')) return 'i-lucide-log-out'
  if (path.startsWith('/user/login')) return 'i-lucide-log-in'
  return 'i-lucide-circle-user'
}

/** The item that starts a session, for the signed-out chrome. */
export function signInItem(items: readonly AccountMenuItem[]): AccountMenuItem | undefined {
  return items.find(item => (item.relative.split('?')[0] ?? '').startsWith('/user/login'))
}
