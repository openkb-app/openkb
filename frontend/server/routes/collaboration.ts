import { defineWebSocketHandler } from 'h3'
import { useHocuspocus } from '../utils/hocuspocus'

export default defineWebSocketHandler({
  open(peer) {
    const hp = useHocuspocus()
    ;(peer as unknown as { _client: unknown })._client = hp.handleConnection(
      peer.websocket as unknown as WebSocket,
      peer.request as unknown as Request,
    )
  },
  message(peer, msg) {
    const client = (peer as unknown as { _client?: { handleMessage(b: Uint8Array): void } })._client
    client?.handleMessage(new Uint8Array(msg.uint8Array()))
  },
  close(peer, ev) {
    const client = (peer as unknown as { _client?: { handleClose(e: { code?: number, reason?: string }): void } })._client
    client?.handleClose({ code: ev.code, reason: ev.reason })
  },
  error(_peer, err) {
    console.error('[collab] ws error', err)
  },
})
