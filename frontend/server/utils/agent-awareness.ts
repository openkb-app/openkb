import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { collabColor, type AgentPeerState, type AwarenessUser } from '#shared/utils/presence'

/**
 * Publishing a server-side peer into a document's awareness.
 *
 * The channel human carets ride, used by the one thing the server puts on it:
 * an agent's session peer (server/utils/agent-peer.ts). It is a peer of the
 * same kind — a client id, a `user` object, a state — and is not a connection.
 */

/** The identity fields a published peer state is built from. */
export interface PeerIdentity {
  /** Drupal uid of the account the peer acts as. */
  uid: number
  /** That account's name — "fago". */
  name: string
  /** Agent client's label — "Claude". Null for the human themselves.
   *  One label per client: `waitForChanges` identifies a writer by it. */
  via: string | null
}

/** A hocuspocus document, as a publisher sees it. */
export type AwareDoc = Y.Doc & { awareness: Awareness }

/**
 * The awareness `user` object a server-side peer publishes.
 *
 * Same shape and same color source as a browser peer's — an agent token acts
 * as its owner's account (OKB-58), so it carries the owner's color and name;
 * `via` is the only thing that separates the two peers, and the strip names
 * it "fago via claude" beside the human's own avatar.
 */
export function agentAwarenessUser(actor: PeerIdentity): AwarenessUser {
  return {
    name: actor.name,
    color: collabColor(actor.uid),
    uid: actor.uid,
    ...(actor.via ? { via: actor.via } : {}),
  }
}

/** A fresh client id from Y.js's own generator, for a peer with no Y.Doc. */
export function newClientId(): number {
  const doc = new Y.Doc()
  const clientId = doc.clientID
  doc.destroy()
  return clientId
}

/**
 * A private awareness instance a peer publishes its state from.
 *
 * Not `document.awareness.setLocalState`: that slot belongs to the server
 * document itself and there is exactly one of it, so two server-side peers on
 * the same document would overwrite each other. Encoding an update for a
 * private client id and applying it lets each own a distinct peer, removable on
 * exit like any disconnecting client.
 */
export function presenceCarrier(clientId: number): Awareness {
  const doc = new Y.Doc()
  doc.clientID = clientId
  return new Awareness(doc)
}

/**
 * (Re)publishes a peer's state into the document's awareness.
 *
 * Awareness updates are clock-ordered per client and a receiver drops anything
 * that is not strictly newer than what it already holds — including the clock
 * bump a timeout eviction leaves behind. A refresh reusing the carrier's own
 * clock would therefore be ignored exactly when it is needed, so every publish
 * steps past whatever the document currently records for this client.
 */
export function publishAwareness(
  document: AwareDoc,
  carrier: Awareness,
  clientId: number,
  state: AgentPeerState | null,
  origin: unknown,
): void {
  const seen = document.awareness.meta.get(clientId)?.clock ?? 0
  const own = carrier.meta.get(clientId)?.clock ?? 0
  carrier.setLocalState(state)
  carrier.meta.set(clientId, { clock: Math.max(seen, own) + 1, lastUpdated: Date.now() })
  applyAwarenessUpdate(document.awareness, encodeAwarenessUpdate(carrier, [clientId]), origin)
}
