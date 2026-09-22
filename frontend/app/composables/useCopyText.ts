/**
 * Puts a short string — an endpoint URL, a one-line command — on the clipboard.
 *
 * The Clipboard API is secure-context only, so a plain-http origin has none;
 * the reader is told to select the text instead of being left with a button
 * that silently does nothing. The text is always on screen and selectable, so
 * the button is a convenience, never the only way to get it.
 */
export function useCopyText() {
  const toast = useToast()

  async function copy(text: string, label: string): Promise<void> {
    const clipboard = globalThis.navigator?.clipboard
    if (!clipboard?.writeText) {
      toast.add({
        title: 'Copy failed',
        description: 'Copying needs a secure (https) connection — select the text and copy it by hand.',
        icon: 'i-lucide-triangle-alert',
        color: 'error',
      })
      return
    }
    try {
      await clipboard.writeText(text)
      toast.add({ title: `${label} copied`, icon: 'i-lucide-clipboard-check' })
    }
    catch {
      toast.add({
        title: 'Copy failed',
        description: 'The text could not be copied. Please select it and copy it by hand.',
        icon: 'i-lucide-triangle-alert',
        color: 'error',
      })
    }
  }

  return { copy }
}
