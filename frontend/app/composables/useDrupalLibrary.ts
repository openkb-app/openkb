/**
 * The `<drupal-library-*>` elements of a custom-elements payload.
 *
 * Drupal attaches libraries to what it renders; `custom_elements` emits one
 * element per library, in dependency order, carrying its JS files and — on the
 * first — the merged drupalSettings.
 */

/** A library element's props, as the CE API ships them. */
export interface DrupalLibraryProps {
  library: string
  js?: { url: string, attributes?: Record<string, unknown> }[]
  drupalSettings?: string
}

/**
 * A library element's props in the shape `useDrupalCe().loadLibrary()` takes.
 *
 * The URLs resolve against this origin, which serves Drupal through the Nitro
 * proxy (server/utils/drupal-proxy.ts); the loader would otherwise prefix the
 * configured backend URL, which is the in-network one.
 */
export function resolveDrupalLibrary(props: DrupalLibraryProps) {
  const origin = useRequestURL().origin
  return {
    name: props.library,
    js: (props.js ?? []).map(file => ({ ...file, url: new URL(file.url, origin).href })),
    drupalSettings: props.drupalSettings,
  }
}
