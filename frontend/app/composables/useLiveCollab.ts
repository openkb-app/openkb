import { HocuspocusProvider } from '@hocuspocus/provider'
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap'
import { IndexeddbPersistence, clearDocument } from 'y-indexeddb'
import * as Y from 'yjs'
import type { AwarenessPeerState } from '#shared/utils/presence'
import { isNoEditAccessReason } from '#shared/utils/collab-auth'
import { deletedAtOf } from '#shared/utils/collab-meta'
import { batchRemoteUpdates } from '~/editor/collab-batching'
import { serializeDocToMarkdown } from '~/comark/markdown-engine'
import { isAuthFailedStatus } from '~/utils/node-chrome'

// 'live': the socket is open and this connection has synced, so the editor
// holds the server's document.
// 'auth-error': the server rejected the session itself (no/expired cookie).
// 'no-access': the session is authenticated but lacks edit access to this
// node — a permission problem, not a sign-in problem.
export type LiveStatus = 'connecting' | 'live' | 'offline' | 'auth-error' | 'no-access'

/**
 * Whether the editor takes keystrokes: once the body is seeded, and while the
 * collab server accepts the session.
 */
export function editorAcceptsInput(hydrated: boolean, status: LiveStatus): boolean {
  return hydrated && !isAuthFailedStatus(status)
}

/** Mirror meta key: when the oldest edit the server has not acknowledged was made. */
export const UNSYNCED_SINCE_KEY = 'unsynced_since'

/** How long the first sync waits for IndexedDB before opening without a mirror. */
export const MIRROR_OPEN_TIMEOUT_MS = 3000

/** A mirror of another document that holds edits the server never acknowledged. */
export interface KeptCopy {
  /** When the oldest of those edits was made (ms). */
  since: number
}

export interface LiveCollabOptions {
  /** Y.Doc that backs the editor. Created by the caller so the same
   *  instance can be passed to TipTap's Collaboration extension; destroyed
   *  here on unmount. */
  ydoc: Y.Doc
  /** Document name on the Hocuspocus server, e.g. `node:42`. */
  name: string
  /** IndexedDB database name for the local mirror, from {@link mirrorKey}.
   *  Read on mount; `null` runs without a mirror. */
  localKey: MaybeRefOrGetter<string | null>
  /** The mirror key of the account the session acts as now. Asked on every
   *  authentication; another answer than the mounted key drops the mirror. */
  currentLocalKey: () => Promise<string | null>
}

/**
 * The mirror's database name, or `null` without a uid.
 *
 * - Per page, so offline edits to page A don't clobber page B.
 * - Per user, so a shared browser profile never hands one user's unsaved
 *   edits to another. Users without a known uid would share one mirror, so
 *   they get none.
 */
export function mirrorKey(nid: number, uid: number | null | undefined): string | null {
  if (!uid) {
    return null
  }
  return `openkb-node-${nid}-${uid}`
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
 * The stored mirror joins the doc on the first sync, and only when it shares a
 * writer with the server's document ({@link sharesWriterWith}). A server that lost its snapshot
 * store rebuilds the document from Drupal; an older mirror merged into that
 * would bring back content Drupal has since replaced. Such a foreign mirror:
 * - holds no edits the server missed → cleared;
 * - holds some → kept apart as {@link KeptCopy}, never merged, until discarded.
 *
 * Mirror lifecycle vs. checkpoints (SAL-324 §10.8): the offline mirror is
 * cleared only when the server signals a *confirmed* commit — `_meta.last_commit`
 * gaining a newer `at` than the one present when this session synced. A failed
 * commit (409/422) writes no `last_commit`, so the mirror is retained and the
 * unsaved edits survive. The mirror is re-created on the next local edit so
 * edits made after the checkpoint are still persisted offline.
 *
 * Without an open mirror (no uid, IndexedDB unavailable, a kept copy holding
 * its database, cleared by a checkpoint, or dropped after the session
 * re-authenticated as another account), edits the server has not acknowledged
 * live in this tab alone: leaving the page then asks to confirm.
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
  // mount, and the WS sync completion. Set once the stored mirror is decided.
  const synced = ref(false)
  // Someone deleted the page this session edits. The server stamps
  // `_meta.deleted_at` while the peer is still connected, then closes the
  // socket — reading it here is the only chance to end the session with a
  // reason, because a reconnect to a document whose node is gone can only fail
  // the auth handshake, which reports "not signed in".
  const deleted = ref(false)
  // Whether edits are mirrored to IndexedDB.
  const mirrorEnabled = ref(false)
  const keptCopy = ref<KeptCopy | null>(null)
  let keptDoc: Y.Doc | null = null

  let metaObserver: (() => void) | null = null
  let disposed = false
  let localKey: string | null = null
  let unsyncedSince: number | null = null
  let adopting: Promise<void> | null = null
  let accountCheck: Promise<void> = Promise.resolve()

  /** Whether this tab alone holds edits; a getter, as `hasUnsyncedChanges` is not reactive. */
  function hasUnmirroredEdits(): boolean {
    if (!synced.value || persistence.value) {
      return false
    }
    return !!provider.value?.hasUnsyncedChanges
  }
  useBeforeUnloadGuard(hasUnmirroredEdits)

  /** Whether leaving may go ahead: nothing to lose, or the editor confirms. */
  function confirmLeave(): boolean {
    if (!hasUnmirroredEdits()) {
      return true
    }
    return window.confirm('Your latest edits have not reached the server yet. Leave and lose them?')
  }
  onBeforeRouteLeave(confirmLeave)
  onBeforeRouteUpdate((to, from) => {
    // Page → page and leaving `?edit` reuse the route component: an update, not
    // a leave. The editor's own query updates on the same page keep `edit`.
    const staysInEditor = to.path === from.path && to.query.edit !== undefined
    if (staysInEditor) {
      return true
    }
    return confirmLeave()
  })

  /** Opens the mirror on the doc. */
  function openMirror(key: string): void {
    persistence.value = new IndexeddbPersistence(key, options.ydoc)
  }

  /**
   * Mirrors a local edit: opens the mirror after a checkpoint cleared it, and
   * flags the edit as not yet acknowledged.
   *
   * Right after a checkpoint the store is empty and the mirror protects only
   * this tab's unsaved writing, so a server write or a peer's edit must not
   * bring it back.
   */
  function onLocalEdit(_update: Uint8Array, _origin: unknown, _doc: Y.Doc, tr: Y.Transaction): void {
    if (!tr.local || !mirrorEnabled.value || !localKey || disposed) {
      return
    }
    if (!persistence.value) {
      openMirror(localKey)
    }
    if (unsyncedSince !== null) {
      return
    }
    unsyncedSince = Date.now()
    void persistence.value!.set(UNSYNCED_SINCE_KEY, unsyncedSince)
  }

  /** Drops the flag once the server holds every edit of this tab. */
  function onAcknowledged(): void {
    if (unsyncedSince === null || !persistence.value) {
      return
    }
    unsyncedSince = null
    void persistence.value.del(UNSYNCED_SINCE_KEY)
  }

  /**
   * Destroys the mirror and deletes its database.
   *
   * The delete is requested before any later open of this key (the
   * re-creation, a remount of the page), as IndexedDB runs them in order: a
   * delete after an open closes that connection under y-indexeddb, whose doc
   * listener then throws on every update.
   */
  function clearMirror(): void {
    if (!persistence.value || !localKey) {
      return
    }
    persistence.value.destroy()
    persistence.value = null
    unsyncedSince = null
    clearDocument(localKey).catch(() => { /* best-effort */ })
  }

  /**
   * Stops mirroring for the rest of this tab. The mirror and any kept copy
   * stay stored: they belong to the account that wrote them.
   */
  function dropMirror(): void {
    localKey = null
    mirrorEnabled.value = false
    persistence.value?.destroy()
    persistence.value = null
    unsyncedSince = null
    keptDoc?.destroy()
    keptDoc = null
    keptCopy.value = null
  }

  /**
   * Drops the mirror when the session now acts as another account, e.g. after
   * a login as another user in a second tab. A failed read drops it too.
   */
  async function checkMirrorAccount(): Promise<void> {
    if (!localKey) {
      return
    }
    const key = await options.currentLocalKey().catch(() => null)
    if (key !== localKey) {
      dropMirror()
    }
  }

  /**
   * Decides the stored mirror once the server's document is in: merges it,
   * clears it, or keeps it apart. Waits for the account check of the
   * authentication before, so another account's mirror is never merged.
   */
  async function adoptMirror(): Promise<void> {
    await accountCheck
    const key = localKey
    if (!key) {
      return
    }
    const stored = await loadMirror(key)
    if (!stored) {
      return
    }
    const since = await stored.persistence.get(UNSYNCED_SINCE_KEY).catch(() => undefined) as number | undefined
    if (disposed || localKey !== key) {
      stored.persistence.destroy()
      stored.doc.destroy()
      return
    }
    const own = sharesWriterWith(stored.doc, options.ydoc)
    if (own) {
      Y.applyUpdate(options.ydoc, Y.encodeStateAsUpdate(stored.doc))
    }
    stored.persistence.destroy()

    if (!own && since) {
      keptDoc = stored.doc
      keptCopy.value = { since }
      return
    }
    stored.doc.destroy()
    if (!own) {
      clearDocument(key).catch(() => { /* best-effort */ })
    }
    openMirror(key)
    mirrorEnabled.value = true
    if (own && since) {
      unsyncedSince = since
    }
    if (!provider.value?.hasUnsyncedChanges) {
      onAcknowledged()
    }
  }

  /** The kept copy's body as Markdown, for copying back. */
  async function keptCopyMarkdown(): Promise<string> {
    if (!keptDoc) {
      return ''
    }
    return serializeDocToMarkdown(yXmlFragmentToProsemirrorJSON(keptDoc.getXmlFragment('default')))
  }

  /** Deletes the kept copy; the page's own edits are mirrored from then on. */
  function discardKeptCopy(): void {
    if (!keptDoc || !localKey) {
      return
    }
    keptDoc.destroy()
    keptDoc = null
    keptCopy.value = null
    clearDocument(localKey).catch(() => { /* best-effort */ })
    if (disposed) {
      return
    }
    openMirror(localKey)
    mirrorEnabled.value = true
  }

  onMounted(() => {
    localKey = toValue(options.localKey)
    const meta = options.ydoc.getMap('_meta')
    // Set on first sync to the checkpoint already recorded in the doc, so we
    // clear the mirror only for commits confirmed *after* we joined — not the
    // historical last_commit that the synced doc arrives carrying.
    let checkpointBaseline = -1

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
    options.ydoc.on('update', onLocalEdit)

    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${wsProto}//${location.host}/collaboration`

    const live = new HocuspocusProvider({
      url,
      name: options.name,
      document: options.ydoc,
      token: csrfToken,
      // Fires once per connection, after the server answered the sync.
      onSynced: () => {
        liveStatus.value = 'live'
        if (checkpointBaseline < 0) {
          const lc = meta.get('last_commit') as { at?: number } | undefined
          checkpointBaseline = Number(lc?.at ?? 0)
        }
        if (!adopting) {
          adopting = adoptMirror()
            .catch((error: unknown) => console.warn('Offline mirror not loaded:', error))
            .finally(() => { synced.value = true })
        }
      },
      onUnsyncedChanges: ({ number }) => {
        if (number === 0) {
          onAcknowledged()
        }
      },
      onAuthenticationFailed: ({ reason }) => {
        liveStatus.value = isNoEditAccessReason(reason) ? 'no-access' : 'auth-error'
        authError.value = reason
      },
      // The websocket keeps retrying after a permission-denied close, so a
      // session that gains access (signed in in another tab, permission
      // granted) authenticates on a later attempt — reset the failed status
      // so the editor unlocks without a reload. The sync follows and sets 'live'.
      onAuthenticated: () => {
        authError.value = null
        if (isAuthFailedStatus(liveStatus.value)) liveStatus.value = 'connecting'
        accountCheck = checkMirrorAccount()
      },
      onAwarenessUpdate: ({ states }) => {
        peers.value = states.length
        awarenessStates.value = states
      },
      // An open socket is still 'connecting': onSynced sets 'live'.
      onStatus: ({ status }) => {
        if (isAuthFailedStatus(liveStatus.value)) return
        liveStatus.value = status === 'disconnected' ? 'offline' : 'connecting'
      },
      onDisconnect: () => {
        if (!isAuthFailedStatus(liveStatus.value)) liveStatus.value = 'offline'
      },
    })
    // Raw instance: updates must carry the provider itself as origin, or it
    // sends them back.
    batchRemoteUpdates(live)
    provider.value = live
  })

  onBeforeUnmount(() => {
    disposed = true
    if (metaObserver) options.ydoc.getMap('_meta').unobserveDeep(metaObserver)
    options.ydoc.off('update', onLocalEdit)
    provider.value?.destroy()
    persistence.value?.destroy()
    keptDoc?.destroy()
  })

  return {
    provider,
    liveStatus,
    peers,
    awarenessStates,
    authError,
    synced,
    deleted,
    mirrorEnabled,
    keptCopy,
    keptCopyMarkdown,
    discardKeptCopy,
  }
}

/**
 * Loads the stored mirror into a doc of its own, or `null` when IndexedDB
 * fails or does not answer in time (private mode can block it).
 */
async function loadMirror(localKey: string): Promise<{ doc: Y.Doc, persistence: IndexeddbPersistence } | null> {
  const doc = new Y.Doc()
  let persistence: IndexeddbPersistence
  try {
    persistence = new IndexeddbPersistence(localKey, doc)
  }
  catch {
    doc.destroy()
    return null
  }
  // `whenSynced` never settles when the open fails: the timeout covers that too.
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), MIRROR_OPEN_TIMEOUT_MS)
  })
  const loaded = await Promise.race([persistence.whenSynced, timeout])
  clearTimeout(timer)
  if (loaded) {
    return { doc, persistence }
  }
  persistence.destroy().catch(() => { /* never opened */ })
  doc.destroy()
  return null
}

/**
 * Whether a mirror was written against this document: the two share a writer.
 * A document rebuilt from Drupal shares none with a mirror of the one it
 * replaced.
 */
function sharesWriterWith(mirror: Y.Doc, doc: Y.Doc): boolean {
  const docWriters = Y.decodeStateVector(Y.encodeStateVector(doc))
  const mirrorWriters = Y.decodeStateVector(Y.encodeStateVector(mirror)).keys()
  for (const client of mirrorWriters) {
    if (docWriters.has(client)) {
      return true
    }
  }
  return false
}
