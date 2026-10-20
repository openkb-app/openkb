import type { ComponentPublicInstance } from 'vue'

/**
 * A `UCommandPalette` ref callback naming its listbox.
 * The palette passes no attributes to its listbox, and its root is a
 * fragment, so the listbox is looked up from the element around it.
 */
export function nameListbox(label: string) {
  return (palette: Element | ComponentPublicInstance | null): void => {
    if (!palette || !('$el' in palette)) return
    const around = (palette.$el as Node).parentElement
    around?.querySelector('[role="listbox"]')?.setAttribute('aria-label', label)
  }
}
