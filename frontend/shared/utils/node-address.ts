/** `/node/<nid>` and `/node/<nid>/edit`, nothing below them. */
const NODE_ADDRESS = /^\/node\/(\d+)(\/edit)?\/?$/

/** A node id in an address: digits only. */
const NODE_ID = /^\d+$/

/** A `/node/<nid>` address: the node id, and whether it asks for the editor. */
export interface NodeAddress {
  nid: number
  edit: boolean
}

/** The node id a path segment names, or null for anything but a positive integer in digits. */
export function parseNodeId(segment: string | undefined): number | null {
  if (!segment || !NODE_ID.test(segment)) return null
  const nid = Number(segment)
  return Number.isSafeInteger(nid) && nid > 0 ? nid : null
}

/** The node address a path names, or null for any other path. */
export function parseNodeAddress(path: string): NodeAddress | null {
  const match = NODE_ADDRESS.exec(path)
  if (!match) return null
  const nid = parseNodeId(match[1])
  if (nid === null) return null
  return { nid, edit: Boolean(match[2]) }
}

/** Whether a resolved path is the node address itself: a page without an alias. */
export function isOwnNodePath(path: string, nid: number): boolean {
  return path === `/node/${nid}`
}
