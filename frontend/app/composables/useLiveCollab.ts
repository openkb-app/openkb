import { HocuspocusProvider } from '@hocuspocus/provider'
import { IndexeddbPersistence } from 'y-indexeddb'
import type * as Y from 'yjs'
import type { AwarenessPeerState } from '#shared/utils/presence'
import { isNoEditAccessReason } from '#shared/utils/collab-auth'
import { deletedAtOf } from '#shared/utils/collab-meta'

// 'auth-error': the server rejected the session itself (no/expired cookie).
// 'no-access': the session is authenticated but lacks edit access to this
// node — a permission problem, not a sign-in problem.
export type LiveStatus = 'connecting' | 'live' | 'offline' | 'auth-error' | 'no-access'

/** Either flavour of collab-auth rejection — the editor must not accept local edits. */
export function isAuthFailedStatus(status: LiveStatus): boolean {
  return status === 'auth-error' || status === 'no-access'
}

export interface LiveCollabOptions {
  /** Y.Doc that backs the editor. Created by the caller so the same
   *  instance can be passed to TipTap's Collaboration extension. */
  ydoc: Y.Doc
  /** Document name on the Hocuspocus server, e.g. `node:42`. */
  name: string
  /** IndexedDB database name for the local mirror — keep per-document
   *  so offline edits to page A don't clobber page B. */
  localKey: string
}

/**
 * Wires a Y.Doc to a Hocuspocus session + IndexedDB mirror. Returns
 * reactive state about the connection (live status, peer count) and
 * the provider itself so the caller can attach extra observers (e.g.
 * a CollaborationCaret pointed at the provider's awareness map).
 *
 * IndexedDB persistence keeps the Y.Doc available across tab close
 * while offline; reconnect Y.js CRDT-merges with the server doc.
 *
 * Mirror lifecycle vs. checkpoints (SAL-324 §10.8): the offline mirror is
 * cleared only when the server signals a *confirmed* commit — `_meta.last_commit`
 * gaining a newer `at` than the one present when this session synced. A failed
 * commit (409/422) writes no `last_commit`, so the mirror is retained and the
 * unsaved edits survive. The mirror is re-created after clearing so edits made
 * after the checkpoint are still persisted offline.
 */
export function useLiveCollab(options: LiveCollabOptions) {
  const provider = ref<HocuspocusProvider | null>(null)
  const persistence = ref<IndexeddbPersistence | null>(null)
  const liveStatus = ref<LiveStatus>('connecting')
  const peers = ref(1)
  // Full awareness states (self included) — the presence strip and anything
  // else that needs *who* is connected rather than just how many.
  const awarenessStates = ref<AwarenessPeerState[]>([])
  const authError = ref<string | null>(null)
  // Reactive sync flag so callers can hydrate the editor exactly once,
  // race-free, no matter the relative order of provider creation, editor
  // mount, and the WS sync completion.
  const synced = ref(false)
  // Someone deleted the page this session edits. The server stamps
  // `_meta.deleted_at` while the peer is still connected, then closes the
  // socket — reading it here is the only chance to end the session with a
  // reason, because a reconnect to a document whose node is gone can only fail
  // the auth handshake, which reports "not signed in".
  const deleted = ref(false)

  let metaObserver: (() => void) | null = null

  onMounted(() => {
    persistence.value = new IndexeddbPersistence(options.localKey, options.ydoc)

    const meta = options.ydoc.getMap('_meta')
    // Set on first sync to the checkpoint already recorded in the doc, so we
    // clear the mirror only for commits confirmed *after* we joined — not the
    // historical last_commit that the synced doc arrives carrying.
    let checkpointBaseline = -1

    function clearMirror(): void {
      const p = persistence.value
      persistence.value = null
      Promise.resolve(p?.clearData()).catch(() => { /* best-effort */ }).finally(() => {
        // Re-mirror lazily on the next LOCAL edit: right after a checkpoint
        // the store is genuinely empty (the committed edits live in Drupal
        // now), and the mirror protects this tab's unsaved writing — a
        // server write (the checkpoint's own attribution snapshot, the
        // sidecar mirror) or a peer's edit must not resurrect it.
        const recreate = (_update: Uint8Array, _origin: unknown, _doc: Y.Doc, tr: Y.Transaction): void => {
          if (!tr.local) return
          options.ydoc.off('update', recreate)
          if (!persistence.value) persistence.value = new IndexeddbPersistence(options.localKey, options.ydoc)
        }
        options.ydoc.on('update', recreate)
      })
    }

    metaObserver = () => {
      if (deletedAtOf(meta) && !deleted.value) {
        deleted.value = true
        // Stop reconnecting: the document is being retired, and every further
        // attempt would only rewrite `liveStatus` with a misleading auth
        // failure while the caller is winding the session down.
        provider.value?.destroy()
      }
      if (checkpointBaseline < 0) return
      const lc = meta.get('last_commit') as { at?: number } | undefined
      const at = Number(lc?.at ?? 0)
      if (at > checkpointBaseline) {
        checkpointBaseline = at
        clearMirror()
      }
    }
    meta.observeDeep(metaObserver)

    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${wsProto}//${location.host}/collaboration`

    provider.value = new HocuspocusProvider({
      url,
      name: options.name,
      document: options.ydoc,
      onSynced: () => {
        synced.value = true
        if (checkpointBaseline < 0) {
          const lc = meta.get('last_commit') as { at?: number } | undefined
          checkpointBaseline = Number(lc?.at ?? 0)
        }
      },
      onAuthenticationFailed: ({ reason }) => {
        liveStatus.value = isNoEditAccessReason(reason) ? 'no-access' : 'auth-error'
        authError.value = reason
      },
      // The websocket keeps retrying after a permission-denied close, so a
      // session that gains access (signed in in another tab, permission
      // granted) authenticates on a later attempt — reset the failed status
      // so the editor unlocks without a reload. 'live' directly: the
      // provider's status hook already fired 'connected' before the auth
      // handshake, so no further onStatus event follows this.
      onAuthenticated: () => {
        authError.value = null
        if (isAuthFailedStatus(liveStatus.value)) liveStatus.value = 'live'
      },
      onAwarenessUpdate: ({ states }) => {
        peers.value = states.length
        awarenessStates.value = states
      },
      onStatus: ({ status }) => {
        if (isAuthFailedStatus(liveStatus.value)) return
        liveStatus.value = status === 'connected' ? 'live' : status === 'connecting' ? 'connecting' : 'offline'
      },
      onDisconnect: () => {
        if (!isAuthFailedStatus(liveStatus.value)) liveStatus.value = 'offline'
      },
    })
  })

  onBeforeUnmount(() => {
    if (metaObserver) options.ydoc.getMap('_meta').unobserveDeep(metaObserver)
    provider.value?.destroy()
    persistence.value?.destroy()
  })

  return { provider, liveStatus, peers, awarenessStates, authError, synced, deleted }
}
