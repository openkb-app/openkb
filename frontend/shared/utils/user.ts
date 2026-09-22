/**
 * The session user as the chrome renders them.
 *
 * `GET /api/me` answers this shape — name/uid/picture null for an anonymous
 * session, which the global auth middleware normally prevents from reaching a
 * page but which stays a valid answer (a session that expired between SSR and
 * the fetch). Every consumer therefore has to render the signed-out case.
 */
export interface OkbUser {
  name: string | null
  uid: number | null
  /** Drupal's `user_picture` file, absolute on the backend origin. */
  picture: string | null
  /**
   * Whether the session may reach the Drupal backend
   * ({@link BACKEND_PERMISSION}). Gates the link into it, which Drupal itself
   * answers with a 403 for anyone else.
   */
  isAdmin: boolean
  /**
   * Whether the add-space CTA is drawn. Drupal still decides the write; this
   * only keeps the UI from offering an action that would 403.
   */
  canCreateSpace: boolean
  /**
   * Whether the session holds `create kb_page content`. The site-wide half
   * of whether the add-page CTA is drawn; the space it would land in has to be
   * writable too (`canWrite` on `/api/spaces`).
   */
  canCreatePage: boolean
}

export const ANONYMOUS_USER: OkbUser = Object.freeze({
  name: null,
  uid: null,
  picture: null,
  isAdmin: false,
  canCreateSpace: false,
  canCreatePage: false,
})

/**
 * What the link into the Drupal backend needs: core's own permission for
 * reaching an admin page. Answered per account by `/api/site-info`.
 */
export const BACKEND_PERMISSION = 'access administration pages'

/** UAvatar props for a session: picture, else initials, else a person icon. */
export function userAvatar(user: OkbUser | null | undefined): {
  src?: string
  text?: string
  icon?: string
} {
  const text = userInitials(user?.name) || undefined
  return {
    src: user?.picture ?? undefined,
    // Also the fallback when the picture fails to load.
    text,
    icon: text ? undefined : 'i-lucide-user',
  }
}

/** Absolute URL of a path on the Drupal backend. */
export function backendUrl(base: string | null | undefined, path: string): string {
  return `${(base ?? '').replace(/\/+$/, '')}${path}`
}

/**
 * Avatar initials for an account name: the first letter of each of the first
 * two words, or the first two letters of a single-word name ("admin" → "AD").
 * Non-letters are separators, so "wolfgang.ziegler" reads as "WZ".
 *
 * Empty for a nameless (anonymous) session — the avatar falls back to its
 * icon rather than showing a placeholder person who does not exist.
 */
export function userInitials(name: string | null | undefined): string {
  const words = (name ?? '').split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (words.length === 0) return ''
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return (words[0]![0]! + words[1]![0]!).toUpperCase()
}
