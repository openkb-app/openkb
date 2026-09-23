/**
 * Request side of Drupal's media-library dialog.
 *
 * Holds which page the dialog belongs to and hands the editor a promise for
 * the selection. Opening it is a mount: the request state drives the `v-if` on
 * `<EditorMediaLibraryDialog>` in PageInlineEditor, and that component owns
 * the dialog for exactly as long as it is on screen.
 */
import type { InjectionKey } from 'vue'

/** One open request: the target page, and which request it is. */
export interface MediaDialogRequest {
  nid: number
  token: number
}

/**
 * The page the editor session is for — set by useEditorSession. The
 * backend grants the dialog by update access on exactly this node.
 */
let activeNid: number | null = null

export function setMediaPickerNode(nid: number): void {
  activeNid = nid
}

/** The open request; null while the dialog is closed. */
export function useMediaDialogRequest() {
  return useState<MediaDialogRequest | null>('okb:media-dialog-request', () => null)
}

/**
 * Lets the dialog's own custom element answer the request it belongs to.
 *
 * The element is rendered from the payload, so it takes no props of ours and
 * cannot hold a token; the dialog component provides the closure that does.
 */
export const cancelMediaDialogKey = Symbol('okb:cancel-media-dialog') as InjectionKey<() => void>

let settle: ((uuids: string[] | null) => void) | null = null
/** Counts requests, so a late answer from an earlier one is ignored. */
let lastToken = 0

/** Opens the dialog; resolves with the selected UUIDs or null on dismiss. */
export async function requestMediaSelection(): Promise<string[] | null> {
  if (activeNid === null) {
    throw new Error('Media picker has no target page — setMediaPickerNode() was never called.')
  }
  const request = useMediaDialogRequest()
  if (request.value !== null) {
    return null
  }
  request.value = { nid: activeNid, token: ++lastToken }
  return new Promise((resolve) => {
    settle = resolve
  })
}

/** Closes the dialog and answers the request the token names, if it is still open. */
export function closeMediaDialog(token: number, uuids: string[] | null): void {
  const request = useMediaDialogRequest()
  if (request.value?.token !== token) {
    return
  }
  request.value = null
  const resolve = settle
  settle = null
  resolve?.(uuids)
}
