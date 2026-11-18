/**
 * A component's boolean prop is comark's bare `name`, and false is not written.
 */
import { describe, expect, test } from 'vitest'
import { parseMarkdownToDoc, parseMarkdownToJson, serializeDocToMarkdown } from '../../app/comark/markdown-engine'

/** Loads `markdown` into the editor doc and writes it back. */
async function roundTripMarkdown(markdown: string): Promise<string> {
  return serializeDocToMarkdown(await parseMarkdownToDoc(markdown))
}

describe('a boolean prop', () => {
  test('a left-out `open` is false and is not written', async () => {
    const markdown = '::details{summary="Logs"}\nBody.\n::'
    expect((await parseMarkdownToJson(markdown)).content?.[0]?.attrs).toMatchObject({ open: false })
    expect(await roundTripMarkdown(markdown)).toBe(markdown)
  })

  test('an `open="true"` is true and is written bare', async () => {
    expect(await roundTripMarkdown('::details{summary="Logs" open="true"}\nBody.\n::')).toBe('::details{summary="Logs" open}\nBody.\n::')
  })
})
