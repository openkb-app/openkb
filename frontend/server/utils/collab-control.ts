import { META_DELETED_AT } from '#shared/utils/collab-meta'
import { COLLAB_IDLE_MS } from './collab-timing'

/**
 * Retiring a live collaboration document, for the one caller that has to write
 * to a node from outside the collab server and cannot be raced: delete.
 *
 * Concurrent JSON:API writes to a single node do not merely last-write-win —
 * they deadlock in InnoDB (`SQLSTATE[40001] … 1213`), and whichever request
 * loses the lock comes back 500 (OKB-90). The collab server is exactly such a
 * concurrent writer: a checkpoint PATCHes the node from a timer, from a peer
 * disconnecting, or from an agent ending its session. A DELETE that does not
 * first stand that machinery down is a coin flip on a 500.
 *
 * So {@link settleDocument} stands it down, in this order:
 *
 *   1. retire  — no *new* checkpoint may be scheduled for this document. This
 *                comes first because step 4 disconnects peers, and a
 *                last-peer-disconnect would otherwise fire an immediate
 *                checkpoint straight into the delete.
 *   2. disarm  — drop the armed quiet / max-dirty timers.
 *   3. drain   — await the in-flight commit, if any. After this the collab
 *                server has no write to the node in flight and no way to start
 *                one, which is the guarantee the caller needs.
 *   4. retire the document — stamp `_meta.deleted_at` so connected peers learn
 *                why their session is ending (a reconnect after the node is
 *                gone can only fail the auth handshake, which carries no
 *                reason), let that update reach them, then close the
 *                connections and drop the document from memory.
 *
 * The deps shape keeps this free of nitro and hocuspocus internals: the plugin
 * owns the scheduler and the retiring set, and hands the closures over
 * (server/plugins/hocuspocus.ts), the same way it hands the agent router its
 * host.
 */

/** The subset of a Y.Doc-backed hocuspocus document this module touches. */
export interface SettleableDocument {
  getConnectionsCount: () => number
  getMap: (name: string) => { set: (key: string, value: unknown) => void }
}

export interface CollabControlDeps {
  /** Documents currently held in memory, by document name. */
  documents: Pick<Map<string, SettleableDocument>, 'get'>
  /** Suppress every future checkpoint trigger for this document. */
  retire: (docName: string) => void
  /** Disarm the document's armed checkpoint timers. */
  disarm: (docName: string) => void
  /** Resolve once no commit is running for this document. */
  waitIdle: (docName: string) => Promise<void>
  /** Force-close every connection to this document. */
  closeConnections: (docName: string) => void
  /** Drop the document from memory. */
  unload: (document: SettleableDocument) => Promise<unknown>
  /** Injectable sleep, so tests don't wait for real time. */
  sleep?: (ms: number) => Promise<void>
}

/** The settle capability the nitro app exposes to request handlers. */
export interface CollabControl {
  settle: (docName: string) => Promise<SettleReport>
}

export interface SettleReport {
  /** Whether the document was held in memory (i.e. someone had it open). */
  live: boolean
  /** Peers connected to it — closed by a settle, counted by an inspect. */
  connections: number
}


/**
 * What the collab server currently holds for one document, without touching it.
 *
 * The read half of {@link SettleReport}: `live` is "someone has this document
 * open", `connections` is how many peers. {@link settleDocument} answers the
 * same question by standing the document down, which is the wrong instrument
 * for anyone who only wants to know.
 */
export function inspectDocument(
  documents: CollabControlDeps['documents'],
  docName: string,
): SettleReport {
  const document = documents.get(docName)
  if (!document) return { live: false, connections: 0 }
  return { live: true, connections: document.getConnectionsCount() }
}


/**
 * Whether an unload may release the per-document state it set out to release.
 *
 * "Unload" is hocuspocus evicting a document from memory after its last
 * client left; the plugin then frees its per-document bookkeeping — the
 * attribution ledger and the captured session above all. Unload does not
 * finish where it starts. It waits for the checkpoint the last departure
 * fired, and a new session can authenticate for the same document inside that
 * wait — putting back the very things this is about to delete. Both sessions
 * are the same document name, so the name cannot tell them apart; the count of
 * claims taken on it can.
 *
 * Releasing another session's state is not a state anything reports. Its
 * ledger loses the baseline its window is measured against, so the burst it is
 * mid-way through reaches Drupal naming nobody; and its checkpoint has no
 * captured session left to re-verify before making that burst durable.
 *
 * @param claimsAtUnload
 *   Claims standing when the unload began, or undefined if it was not seen.
 * @param claimsNow
 *   Claims standing now.
 *
 * @return
 *   TRUE when no session has claimed the document since the unload began.
 */
export function unloadMayRelease(claimsAtUnload: number | undefined, claimsNow: number): boolean {
  return claimsAtUnload === undefined || claimsAtUnload === claimsNow
}

/**
 * Stand the collab server down for one document and resolve once it holds no
 * write to the node and can start none.
 *
 * Idempotent and safe for a document nobody has open — the retire + drain
 * still matter there, because a document can be mid-unload with a checkpoint
 * in flight.
 */
export async function settleDocument(
  deps: CollabControlDeps,
  docName: string,
): Promise<SettleReport> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))

  deps.retire(docName)
  deps.disarm(docName)
  await deps.waitIdle(docName)

  const document = deps.documents.get(docName)
  if (!document) return { live: false, connections: 0 }

  const connections = document.getConnectionsCount()
  if (connections > 0) {
    document.getMap('_meta').set(META_DELETED_AT, Date.now())
    await sleep(COLLAB_IDLE_MS)
  }
  deps.closeConnections(docName)
  // A close can start hocuspocus' own unload; both paths are guarded against
  // double-unloading, and a failure here must not stop the delete — the
  // document is only in memory.
  try {
    await deps.unload(document)
  }
  catch (err) {
    console.error(`[collab] unload ${docName} after settle failed:`, (err as Error).message)
  }
  return { live: true, connections }
}
