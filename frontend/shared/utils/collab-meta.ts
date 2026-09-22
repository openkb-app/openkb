/**
 * `_meta` keys the server writes and the client observes. The Y.Doc map is the
 * only channel between the two for document-lifecycle facts, so the key names
 * live here rather than being spelled out on both sides.
 *
 * Most of `_meta` is the commit lane and documented in the hocuspocus plugin
 * header; this module holds the keys a client *reacts* to structurally.
 */

/**
 * Epoch millis stamped just before a document is retired because its node is
 * being deleted (server/utils/collab-control.ts). Peers get it while they are
 * still connected, which is the point: once the node is gone a reconnect can
 * only fail the auth handshake, and a failed handshake cannot tell an editor
 * *why* its session ended.
 */
export const META_DELETED_AT = 'deleted_at'

/** Reads the deletion stamp out of a synced `_meta` snapshot. */
export function deletedAtOf(meta: { get: (key: string) => unknown }): number | null {
  const at = Number(meta.get(META_DELETED_AT) ?? 0)
  return at > 0 ? at : null
}
