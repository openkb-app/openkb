import { MessageType, type HocuspocusProvider } from '@hocuspocus/provider'
import * as decoding from 'lib0/decoding'
import { messageYjsUpdate } from 'y-protocols/sync'
import * as Y from 'yjs'

/** How long peers' document updates gather before they are applied together. */
export const REMOTE_BATCH_MS = 100

/** The message type and, for sync messages, the sync step. */
function kindOf(data: ArrayBuffer): { type: number, sync?: number } {
  const decoder = decoding.createDecoder(new Uint8Array(data))
  decoding.readVarString(decoder)
  const type = decoding.readVarUint(decoder)
  return type === MessageType.Sync ? { type, sync: decoding.readVarUint(decoder) } : { type }
}

/**
 * Applies peers' document updates in one Y transaction per window, not one per
 * message. The editor pays a full dispatch and re-render per transaction, so
 * its work per second follows the window, not the number of peers typing.
 * - Only update messages wait; sync steps and auth go straight on.
 * - Awareness waits while updates do and follows them in arrival order: a
 *   peer's caret is anchored on text that must be there first.
 * - On socket close, waiting awareness is dropped: the provider has just
 *   removed every peer, and must not bring them back.
 * - The provider's destroy applies what is waiting and stops the batching.
 */
export function batchRemoteUpdates(provider: HocuspocusProvider, windowMs = REMOTE_BATCH_MS): void {
  const deliver = provider.onMessage.bind(provider)
  const updates: MessageEvent[] = []
  const behind: MessageEvent[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  /**
   * Applies the waiting updates as one remote transaction, then the awareness
   * behind them. Each message leaves the queue as it is delivered, so one that
   * throws leaves the rest for the next window.
   */
  function flush() {
    timer = null
    try {
      // Remote, like each update on its own: origin the provider, not local.
      Y.transact(provider.document, () => {
        while (updates.length) deliver(updates.shift()!)
      }, provider, false)
      while (behind.length) deliver(behind.shift()!)
    }
    finally {
      if (updates.length || behind.length) timer = setTimeout(flush, windowMs)
    }
  }

  provider.onMessage = (event: MessageEvent) => {
    const { type, sync } = kindOf(event.data)
    if (sync === messageYjsUpdate) {
      updates.push(event)
      timer ??= setTimeout(flush, windowMs)
    }
    else if (type === MessageType.Awareness && timer) behind.push(event)
    else deliver(event)
  }

  provider.on('close', () => { behind.length = 0 })

  provider.on('destroy', () => {
    try {
      if (timer) {
        clearTimeout(timer)
        flush()
      }
    }
    finally {
      if (timer) clearTimeout(timer)
      timer = null
      provider.onMessage = deliver
    }
  })
}
