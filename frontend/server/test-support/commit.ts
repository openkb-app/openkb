import { commitDocument, type CollabWrite, type CommitOptions, type CommitResult } from '../utils/commit'

/** A collab write naming nobody and no writers. */
export const NO_WINDOW: CollabWrite = { actingUid: null, coAuthors: [], blocks: {}, actions: [] }

/** {@link NO_WINDOW} as the commit route receives it. */
export const NO_WINDOW_WIRE = { acting_uid: null, blocks: {}, actions: [] }

/** A commit stating an empty window unless the test states one. */
export function commit(
  host: Parameters<typeof commitDocument>[0],
  docName: string,
  options: Omit<CommitOptions, 'collabWrite'> & { collabWrite?: CollabWrite },
): Promise<CommitResult> {
  return commitDocument(host, docName, { collabWrite: NO_WINDOW, ...options })
}
