/**
 * Collab auth-failure reason contract between the Hocuspocus server plugin
 * (server/plugins/hocuspocus.ts, which throws the reason) and the client
 * (app/composables/useLiveCollab.ts, which maps it to a LiveStatus). The
 * WS close frame carries only this string, so both sides share it here.
 */

/** Prefix of the rejection thrown for an authenticated session without edit access. */
export const NO_EDIT_ACCESS_PREFIX = 'No edit access'

export function noEditAccessReason(nid: number): string {
  return `${NO_EDIT_ACCESS_PREFIX} to node ${nid}`
}

/**
 * Rejection for a session whose fields are not all editable by the joiner.
 *
 * A field-access denial is a no-access case like any other, so it keeps the
 * prefix and the client's `no-access` status; the fields are what tells the
 * user (and the log reader) which ones. `null` is the site not answering the
 * check at all, which is refused the same way and says so.
 */
export function noFieldAccessReason(nid: number, fields: string[] | null): string {
  const detail = fields === null
    ? 'the site did not answer the field-access check'
    : `cannot edit ${fields.join(', ')}`
  return `${noEditAccessReason(nid)}: ${detail}`
}

export function isNoEditAccessReason(reason: string | null | undefined): boolean {
  return !!reason && reason.startsWith(NO_EDIT_ACCESS_PREFIX)
}
