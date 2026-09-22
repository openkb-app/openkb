/**
 * The join gate's one question to Drupal.
 *
 * Admission is write control: the Y.Doc is a shared buffer, so anyone admitted
 * can influence content the next checkpoint commits under whoever's
 * credentials carry it. Two Drupal decisions bound it — update access to the
 * node, and edit access to every field the session exposes — and they are
 * separate decisions, so a field the joiner may not edit would otherwise be
 * editable through the document.
 *
 * `GET /openkb/node/<nid>/join-access` answers both under the carrier the gate
 * presents, together with the account Drupal authenticated. The browser WS gate
 * and the agent gate ask it the same way, and a join costs one request.
 */

/** The account Drupal answered for. */
export interface JoinAccount { name: string, uid: number }

/** What one join-access read tells the gate about a carrier and a node. */
export interface JoinAnswer {
  /** Node update access, as Drupal decided it for this account. */
  update: boolean
  /** Session fields the account may not edit; null when Drupal did not say. */
  denied: string[] | null
  /** The account behind the carrier, or null when the answer did not name it. */
  account: JoinAccount | null
}

/** The URL the gate reads a node's join access from. */
export function joinAccessUrl(drupalBaseUrl: string, nid: number): string {
  return `${drupalBaseUrl.replace(/\/$/, '')}/openkb/node/${nid}/join-access`
}

/**
 * Reads the route's answer.
 *
 * Nothing is granted unless the payload states it: this is a security gate,
 * and an answer that was not given is not a grant. `denied` stays null on
 * anything unreadable, which the callers refuse on.
 */
export function parseJoinAnswer(payload: unknown): JoinAnswer {
  const body = payload as {
    update?: unknown
    denied_fields?: unknown
    account?: { uid?: unknown, name?: unknown }
  } | null
  if (!body || typeof body !== 'object') return { update: false, denied: null, account: null }
  return {
    update: body.update === true,
    denied: Array.isArray(body.denied_fields)
      ? body.denied_fields.filter((name): name is string => typeof name === 'string')
      : null,
    account: body.account
      ? {
          uid: Number(body.account.uid) || 0,
          name: typeof body.account.name === 'string' ? body.account.name : '',
        }
      : null,
  }
}
