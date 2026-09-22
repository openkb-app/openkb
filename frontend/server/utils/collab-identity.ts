import { drupalBaseUrl } from './drupal'
import { fetchUpstream } from './upstream'

/**
 * The collaboration server's own account (ADR 0001).
 *
 * It writes on behalf of editing sessions — checkpoints, conversations, seeds
 * — and its statements name other people, so Drupal has to know the caller is
 * the server. It is therefore one required `client_credentials` OAuth client:
 * server-initiated requests carry its Bearer token and nothing else, and what
 * it may do is what its role says (`use collaboration api`,
 * `state inline comment authors`). Peers still authenticate their websocket
 * with their own session — who may join a document is unchanged.
 *
 * A captured peer cookie is never replayed on a request the server starts. A
 * note then survives every peer disconnecting, and a checkpoint no longer
 * depends on whichever session happened to authenticate last.
 */

const CLIENT_ID = process.env.OKB_COLLAB_CLIENT_ID ?? ''
const CLIENT_SECRET = process.env.OKB_COLLAB_CLIENT_SECRET ?? ''

/** Renew this long before the token actually expires. */
const RENEW_BEFORE_MS = 30_000

/** The token request currently running — what concurrent callers wait on rather than
 *  starting one of their own. */
let issuing: Promise<string> | null = null
/** The last token request that succeeded, re-used until it is nearly expired. */
let held: Promise<string> | null = null
let expiresAt = 0

/** Whether this deployment gave the server an identity at all. */
export function collabIdentityConfigured(): boolean {
  return CLIENT_ID !== '' && CLIENT_SECRET !== ''
}

/**
 * The server's access token, issued on demand and shared until it expires.
 *
 * The promise is what is cached, not its value: concurrent callers on a cold
 * cache wait on the one round trip rather than racing each other to
 * /oauth/token. The two handles are separate because the expiry is not known
 * until the request answers — one cache keyed on a deadline of zero would let
 * every concurrent caller start a request of its own.
 */
function token(): Promise<string> {
  if (issuing) return issuing
  if (held && Date.now() < expiresAt - RENEW_BEFORE_MS) return held
  const pending = (async () => {
    const res = await fetchUpstream(`${drupalBaseUrl()}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        scope: 'collab',
      }).toString(),
    })
    if (!res.ok) {
      throw new Error(`collab token request failed: HTTP ${res.status}`)
    }
    const granted = await res.json() as { access_token: string, expires_in?: number }
    expiresAt = Date.now() + (granted.expires_in ?? 300) * 1000
    return granted.access_token
  })()
  issuing = pending
  held = pending
  // A failed token request must not be kept, or one blip locks the server out for the
  // lifetime of a token it never got.
  pending.then(
    () => { issuing = null },
    () => { issuing = null; forgetCollabToken() },
  )
  return pending
}

/** Drops the held token, so the next call issues a fresh one. */
export function forgetCollabToken(): void {
  held = null
  expiresAt = 0
}

/**
 * The server's auth carrier, or nothing when it has no identity configured.
 *
 * Empty rather than throwing: every lane that uses it already treats "no
 * carrier" as "cannot ask", and says so — see the seed lanes in
 * server/plugins/hocuspocus.ts.
 */
export async function collabAuthHeaders(): Promise<Record<string, string>> {
  if (!collabIdentityConfigured()) return {}
  try {
    return { Authorization: `Bearer ${await token()}` }
  }
  catch (err) {
    console.error('[collab] no access token:', (err as Error).message)
    return {}
  }
}

/**
 * Runs one request as the server, issuing a fresh token if the held one is
 * refused.
 *
 * A token outlives the process that holds it and Drupal may retire it — the
 * consumer re-provisioned, the keys rotated. That reads as a 401 on an
 * otherwise valid request, which one retry answers; anything else is the
 * caller's to handle.
 */
export async function asCollabServer<T>(
  run: (auth: Record<string, string>) => Promise<T>,
): Promise<T> {
  const auth = await collabAuthHeaders()
  try {
    return await run(auth)
  }
  catch (err) {
    if ((err as { statusCode?: number })?.statusCode !== 401 || Object.keys(auth).length === 0) throw err
    forgetCollabToken()
    return run(await collabAuthHeaders())
  }
}
