/** The most uids one account lookup answers: one JSON:API page. */
export const ACCOUNT_LOOKUP_LIMIT = 50

/** Whether a value can be an account id: a positive 32-bit integer. */
export function isAccountUid(uid: number): boolean {
  return Number.isInteger(uid) && uid > 0 && uid < 2 ** 31
}
