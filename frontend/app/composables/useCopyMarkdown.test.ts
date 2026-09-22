import { describe, it, expect, vi, afterEach } from 'vitest'
import { ref, toValue } from 'vue'
import { useCopyMarkdown, copyFailureReason, ClipboardUnavailableError } from './useCopyMarkdown'

const HREF = '/api/kb/general/getting-started.md'
const MARKDOWN = '---\ntype: guide\n---\n\nThe body, block ids and all. {#b-4f2a}\n'

/**
 * Stand the composable's Nuxt auto-imports up as globals — this suite runs on
 * plain vitest, outside the Nuxt runtime that normally provides them.
 */
function stubRuntime(clipboard?: { writeText: (text: string) => Promise<void> }) {
  const toasts: { title: string, description: string }[] = []
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('toValue', toValue)
  vi.stubGlobal('useToast', () => ({ add: (t: { title: string, description: string }) => toasts.push(t) }))
  vi.stubGlobal('navigator', { clipboard })
  vi.stubGlobal('$fetch', vi.fn(async () => MARKDOWN))
  return toasts
}

afterEach(() => { vi.unstubAllGlobals() })

/**
 * The copy is worth having only if a paste and an agent's
 * `tool_api__get_page` are the
 * same document, so what reaches the clipboard must be the endpoint's bytes —
 * not the rendered DOM, and not the body without its frontmatter block.
 */
describe('useCopyMarkdown', () => {
  it('puts the bytes the .md endpoint served on the clipboard', async () => {
    const writeText = vi.fn(async () => {})
    const toasts = stubRuntime({ writeText })

    await useCopyMarkdown(HREF).copy()

    expect(globalThis.$fetch).toHaveBeenCalledWith(HREF, { responseType: 'text' })
    expect(writeText).toHaveBeenCalledWith(MARKDOWN)
    expect(toasts).toHaveLength(1)
    expect(toasts[0]!.title).toBe('Copied as Markdown')
  })

  it('tells the reader when the origin has no clipboard, and claims no copy', async () => {
    const toasts = stubRuntime(undefined)

    await useCopyMarkdown(HREF).copy()

    expect(toasts).toHaveLength(1)
    expect(toasts[0]!.title).toBe('Copy failed')
    expect(toasts[0]!.description).toMatch(/https/)
  })
})

/**
 * What a failed copy tells the reader. The copy reads the same `.md` address
 * the link next to it points at, so it inherits that endpoint's refusals. Those
 * a reader can act on — including an http origin, where the Clipboard API does
 * not exist — must not be flattened into "try again"; the rest stays generic.
 */
describe('copyFailureReason', () => {
  it('names a refusal the reader can act on', () => {
    expect(copyFailureReason({ statusCode: 403 })).toMatch(/permission/i)
    expect(copyFailureReason({ statusCode: 404 })).toMatch(/no longer available/i)
  })

  it('says an insecure origin has no clipboard, and points at the .md link', () => {
    const reason = copyFailureReason(new ClipboardUnavailableError())
    expect(reason).toMatch(/https/)
    expect(reason).toMatch(/\.md link/)
  })

  it('stays generic for anything else', () => {
    const generic = 'The page could not be copied. Please try again.'
    expect(copyFailureReason({ statusCode: 500, statusMessage: 'ECONNREFUSED at 10.0.0.4' })).toBe(generic)
    expect(copyFailureReason(new Error('boom'))).toBe(generic)
    expect(copyFailureReason(undefined)).toBe(generic)
  })
})
