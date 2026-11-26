/**
 * The links an invite mail carries: a one-time login and the accept page.
 */

/** The one-time login link: the invitee's, or a password reset's. */
export const ONE_TIME_LOGIN = /^\/user\/reset\//

const INVITE_ACCEPT = /^\/invite\/\d+$/

/**
 * Why a mailed link opens no more.
 *
 * - `login-refused`: a one-time login Drupal refuses: used, expired, or its
 *   account is gone or blocked.
 * - `invite-gone`: the accept page is gone: cancelled or expired.
 * - `invite-closed`: the accept page is refused to its signed-in reader:
 *   accepted, or sent to another account.
 */
export type DeadMailedLink = 'login-refused' | 'invite-gone' | 'invite-closed'

/**
 * Tells which mailed link a refused or missing page is, if any.
 *
 * A signed-out reader refused the accept page gets none: the invite may still
 * be pending, signing in opens it.
 */
export function deadMailedLink(path: string, statusCode: number, isSignedIn: boolean): DeadMailedLink | null {
  if (statusCode !== 403 && statusCode !== 404) {
    return null
  }
  if (ONE_TIME_LOGIN.test(path)) {
    return 'login-refused'
  }
  if (!INVITE_ACCEPT.test(path)) {
    return null
  }
  if (statusCode === 404) {
    return 'invite-gone'
  }
  return isSignedIn ? 'invite-closed' : null
}
