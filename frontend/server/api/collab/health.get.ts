import { defineEventHandler } from 'h3'
import { useHocuspocus } from '../../utils/hocuspocus'

/**
 * Liveness probe for the embedded Hocuspocus server (docker-compose
 * healthcheck on frontend; reuse for any hosted liveness probe).
 *
 * Unauthenticated by design, so it must stay aggregate-only: counts and
 * uptime, never document names or per-document detail.
 */
export default defineEventHandler(() => {
  const hp = useHocuspocus()
  return {
    status: 'ok',
    documents: hp.getDocumentsCount(),
    connections: hp.getConnectionsCount(),
    uptime: Math.round(process.uptime()),
  }
})
