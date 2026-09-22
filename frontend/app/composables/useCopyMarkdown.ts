/**
 * Puts a page's `.md` projection on the clipboard — the frontmatter block
 * and the comark body, exactly the bytes `GET /api/kb/<path>.md` serves.
 *
 * The endpoint is the source, never the rendered DOM, so a reader's paste and
 * an agent's `tool_api__get_page` are the same document. It costs one request, which
 * also scopes the copy to what the session is allowed to see.
 */
export function useCopyMarkdown(href: MaybeRefOrGetter<string | undefined>) {
  const toast = useToast()
  const copying = ref(false)

  async function copy() {
    const url = toValue(href)
    if (copying.value || !url) return

    copying.value = true
    try {
      const markdown = await $fetch<string>(url, { responseType: 'text' })
      const clipboard = globalThis.navigator?.clipboard
      if (!clipboard?.writeText) throw new ClipboardUnavailableError()
      await clipboard.writeText(markdown)
      toast.add({
        title: 'Copied as Markdown',
        description: 'The page is on your clipboard, frontmatter and all.',
        icon: 'i-lucide-clipboard-check',
      })
    }
    catch (err) {
      toast.add({
        title: 'Copy failed',
        description: copyFailureReason(err),
        icon: 'i-lucide-triangle-alert',
        color: 'error',
      })
    }
    finally {
      copying.value = false
    }
  }

  return { copy, copying }
}

/** The Clipboard API is secure-context only, so a plain-http origin has none. */
export class ClipboardUnavailableError extends Error {
  constructor() {
    super('No clipboard available')
    this.name = 'ClipboardUnavailableError'
  }
}

/**
 * What to tell the reader when the copy did not happen. Only refusals they can
 * act on are named; anything else stays generic rather than surfacing an
 * upstream message written for a different audience.
 */
export function copyFailureReason(err: unknown): string {
  if (err instanceof ClipboardUnavailableError) {
    return 'Copying needs a secure (https) connection. Use the .md link instead.'
  }
  const status = (err as { statusCode?: number })?.statusCode
  if (status === 403) return 'You do not have permission to read this page.'
  if (status === 404) return 'This page is no longer available.'
  return 'The page could not be copied. Please try again.'
}
