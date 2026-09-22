import { defineEventHandler, createError } from 'h3'
import { useHocuspocus, flushPendingStores } from '../../utils/hocuspocus'

/**
 * Force-run all pending debounced document stores.
 *
 * Loopback-only: exists for in-container shutdown wrappers
 * (frontend/scripts/dev-server.sh) and pre-stop hooks that must flush the
 * SQLite snapshot before the process is terminated. `nuxt dev` runs the
 * nitro app in a worker thread where POSIX signals never arrive, so an
 * HTTP-triggered flush is the only reliable shutdown path there.
 */
export default defineEventHandler(async (event) => {
  // Loopback gate. In production (node-server entry) remoteAddress is the
  // real peer and the gate is effective. In `nuxt dev` requests reach the
  // nitro worker over an internal channel and remoteAddress is empty for
  // every request — the gate is advisory there, which is acceptable: the
  // flush is idempotent, leaks nothing, and only writes state that would be
  // written 2s later anyway.
  const remote = event.node.req.socket.remoteAddress ?? ''
  if (remote !== '' && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
    throw createError({ statusCode: 403, statusMessage: 'Loopback only' })
  }
  const flushed = await flushPendingStores(useHocuspocus())
  return { flushed }
})
