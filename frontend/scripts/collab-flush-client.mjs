// WS client for the shutdown-flush test (scripts/collab-flush-test.sh at the
// repo root drives it). Runs OUTSIDE the frontend container (sidecar) so the
// connection is still open while frontend is being stopped.
//
//   node collab-flush-client.mjs edit <value>   connect, write value into the
//                                               `_test` map, print EDIT_DONE,
//                                               keep the connection open
//   node collab-flush-client.mjs read <value>   connect, assert the `_test`
//                                               map holds value (MATCH /
//                                               MISMATCH, exit code 0 / 1)
//
// Env: OKB_COLLAB_WS_URL (ws endpoint), OKB_TOKEN (Drupal session cookie),
//      OKB_DOC (document name, default node:1).
import WebSocket from 'ws'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'

const [mode, value] = process.argv.slice(2)
const url = process.env.OKB_COLLAB_WS_URL ?? 'ws://frontend:3000/collaboration'
const token = process.env.OKB_TOKEN ?? ''
const docName = process.env.OKB_DOC ?? 'node:1'
const KEY = 'flushProbe'

if (!['edit', 'read'].includes(mode) || !value || !token) {
  console.error('usage: OKB_TOKEN=<cookie> node collab-flush-client.mjs edit|read <value>')
  process.exit(2)
}

// The cookie rides the WS handshake header, exactly as a browser sends it —
// a handshake token is refused (agents join the session in-process instead,
// not over the socket).
class CookieWebSocket extends WebSocket {
  constructor(address, protocols) {
    super(address, protocols, { headers: { Cookie: token } })
  }
}
const socket = new HocuspocusProviderWebsocket({ url, WebSocketPolyfill: CookieWebSocket })
const provider = new HocuspocusProvider({
  websocketProvider: socket,
  name: docName,
  onAuthenticationFailed: ({ reason }) => {
    console.error(`AUTH_FAILED ${reason}`)
    process.exit(2)
  },
  onSynced: () => {
    const map = provider.document.getMap('_test')
    if (mode === 'edit') {
      map.set(KEY, value)
      console.log(`EDIT_DONE ${Date.now()}`)
      // Keep the process (and with it the WS connection) alive until the
      // orchestrating script kills the container. The pending debounced
      // store on the server is what the shutdown flush must rescue.
      setInterval(() => {}, 60_000)
    }
    else {
      const found = map.get(KEY)
      if (found === value) {
        console.log('MATCH')
        process.exit(0)
      }
      console.error(`MISMATCH expected=[${value}] found=[${found ?? ''}]`)
      process.exit(1)
    }
  },
})
provider.attach()

setTimeout(() => {
  console.error('TIMEOUT no sync within 15s')
  process.exit(2)
}, 15_000).unref?.()
