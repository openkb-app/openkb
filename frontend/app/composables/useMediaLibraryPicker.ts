/**
 * Opens Drupal's own media-library dialog in the editor page.
 *
 * The Nitro proxy (server/utils/drupal-proxy.ts) serves Drupal same-origin,
 * so this loads Drupal's dialog libraries once — from the module's assets
 * endpoint, which also returns the server-built MediaLibraryState dialog
 * URL — and then triggers `Drupal.ajax` exactly like a coupled admin page:
 * Drupal's AJAX commands open Drupal's native dialog (browse + upload) in
 * the current document. "Insert selected" answers with an AJAX command that
 * dispatches `okb:media-selected` on `document` (js/selection.js in the
 * openkb_media_library module) and closes the dialog.
 *
 * Client-only by construction: the editor mounts inside <ClientOnly>.
 */

interface AssetsManifest {
  dialogUrl: string
  css: string[]
  js: string[]
  settings: Record<string, unknown>
}

interface DrupalGlobal {
  ajax(settings: Record<string, unknown>): { execute(): void }
}

declare global {
  interface Window {
    Drupal?: DrupalGlobal
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`Failed to load ${src}`))
    document.body.appendChild(script)
  })
}

async function loadDialogAssets(nid: number): Promise<string> {
  // The nid scopes the server-built MediaLibraryState: access to the dialog
  // is update access on that page (checked backend-side by the opener).
  const manifest = await $fetch<AssetsManifest>('/openkb/media-library/assets', { query: { nid } })

  // drupalSettings must be in the DOM before core/drupalSettings executes —
  // its loader parses this exact script tag.
  if (!document.querySelector('script[data-drupal-selector="drupal-settings-json"]')) {
    const settings = document.createElement('script')
    settings.type = 'application/json'
    settings.setAttribute('data-drupal-selector', 'drupal-settings-json')
    settings.textContent = JSON.stringify(manifest.settings)
    document.body.appendChild(settings)
  }

  // Drupal's CSS goes BEFORE the app's stylesheets: generic rules in it
  // (e.g. core's `.hidden { display: none }`) must lose against the app's
  // own utilities (`hidden lg:flex`) — cascade order decides, both have
  // equal specificity. The dialog's own markup only uses Drupal classes,
  // so early placement costs it nothing.
  const anchor = document.head.querySelector('link[rel="stylesheet"], style')
  for (const href of manifest.css) {
    if (!document.querySelector(`link[href="${CSS.escape(href)}"]`)) {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = href
      document.head.insertBefore(link, anchor)
    }
  }
  // Sequential: Drupal's JS relies on load order (jquery → drupal → …).
  // Skip already-present scripts — a second manifest (other page, same
  // session) must not re-execute Drupal's JS.
  for (const src of manifest.js) {
    if (!document.querySelector(`script[src="${CSS.escape(src)}"]`)) {
      await loadScript(src)
    }
  }
  return manifest.dialogUrl
}

// Dialog URLs are per-page (the state carries the nid); assets load once,
// guarded by the existing-tag checks above.
const dialogUrlPromises = new Map<number, Promise<string>>()

/**
 * The page the editor session is for — set by useEditorSession. The
 * backend grants the dialog by update access on exactly this node.
 */
let activeNid: number | null = null

export function setMediaPickerNode(nid: number): void {
  activeNid = nid
}

/** Opens the dialog; resolves with the selected UUIDs or null on dismiss. */
export async function requestMediaSelection(): Promise<string[] | null> {
  const nid = activeNid
  if (nid === null) {
    throw new Error('Media picker has no target page — setMediaPickerNode() was never called.')
  }
  let promise = dialogUrlPromises.get(nid)
  if (!promise) {
    promise = loadDialogAssets(nid).catch((error) => {
      // Failed loads don't poison later attempts.
      dialogUrlPromises.delete(nid)
      throw error
    })
    dialogUrlPromises.set(nid, promise)
  }
  const dialogUrl = await promise

  return new Promise((resolve) => {
    let settled = false
    const settle = (uuids: string[] | null) => {
      if (settled) return
      settled = true
      document.removeEventListener('okb:media-selected', onSelected)
      document.removeEventListener('dialog:afterclose', onClosed)
      resolve(uuids)
    }
    // Selection command runs before the close command, so a real selection
    // always settles first; afterclose then finds it settled.
    const onSelected = (event: Event) => {
      const detail = (event as CustomEvent<{ uuids?: string[] }>).detail
      settle(Array.isArray(detail?.uuids) ? detail.uuids : [])
    }
    const onClosed = () => settle(null)
    document.addEventListener('okb:media-selected', onSelected)
    // DrupalDialogEvent bubbles from the dialog element.
    document.addEventListener('dialog:afterclose', onClosed)

    window.Drupal!.ajax({
      url: dialogUrl,
      dialogType: 'modal',
      dialog: { title: 'Media library', width: '80%' },
      progress: { type: 'fullscreen' },
    }).execute()
  })
}
