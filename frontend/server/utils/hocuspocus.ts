import { useNitroApp } from 'nitropack/runtime'
import type { Hocuspocus } from '@hocuspocus/server'
import type { RouterDeps } from './session-router'
import type { CollabControl } from './collab-control'
import type { CommitIdentity, CommitResult, CommitTrigger } from './commit'

export function useHocuspocus(): Hocuspocus {
  return (useNitroApp() as unknown as { hocuspocus: Hocuspocus }).hocuspocus
}

/**
 * Checkpoint one document — the ONE way this application writes a live
 * session to Drupal. A checkpoint closes the attribution ledger and states
 * the window's accounting with the text; calling `commitDocument` directly
 * gets the write and silently none of that — a co-author approving their
 * own writing.
 */
export function useCheckpoint(): (
  docName: string,
  trigger: CommitTrigger,
  identity: CommitIdentity,
) => Promise<CommitResult> {
  return (useNitroApp() as unknown as { okbCheckpoint: (d: string, t: CommitTrigger, i: CommitIdentity) => Promise<CommitResult> }).okbCheckpoint
}

/** The agent session router's dependencies, wired by the collab plugin. */
export function useAgentRouter(): RouterDeps {
  return (useNitroApp() as unknown as { okbAgentRouter: RouterDeps }).okbAgentRouter
}

/** Document-lifecycle control (settle-before-delete), wired by the collab plugin. */
export function useCollabControl(): CollabControl {
  return (useNitroApp() as unknown as { okbCollabControl: CollabControl }).okbCollabControl
}

/**
 * Immediately execute all pending debounced onStoreDocument calls, so edits
 * made within the store-debounce window (default 2s) reach SQLite before the
 * process dies. Mirrors `hp.flushPendingStores()`, but collects the store
 * promises so callers can await the actual writes instead of firing and
 * hoping. Returns the number of documents flushed.
 */
export async function flushPendingStores(hp: Hocuspocus): Promise<number> {
  const flushes: Promise<unknown>[] = []
  for (const document of hp.documents.values()) {
    const debounceId = `onStoreDocument-${document.name}`
    if (!document.isLoading && hp.debouncer.isDebounced(debounceId)) {
      flushes.push(
        Promise.resolve(hp.debouncer.executeNow(debounceId)).catch(err =>
          console.error(`[collab] flush ${document.name} failed:`, (err as Error).message),
        ),
      )
    }
  }
  await Promise.all(flushes)
  return flushes.length
}
