/**
 * MDC prop-brace grammar on the editor load path.
 *
 * comark accepts double-quoted, single-quoted and unquoted prop values;
 * the editor must read all three, or an authored value falls back to the
 * node's schema default on load.
 */
import { describe, expect, test } from 'vitest'
import { parseMarkdownToJson } from '../../app/comark/markdown-engine'

describe('unquoted props survive the load path', () => {
  const firstBlock = async (markdown: string) => (await parseMarkdownToJson(markdown)).content?.[0]

  test('a `}` inside a quoted value does not close the brace', async () => {
    const file = '11111111-2222-4333-8444-555555555555'
    expect(await firstBlock(`::attachment{file="${file}" description="Plan {v2} \\"final\\""}\n::`))
      .toMatchObject({ type: 'attachment', attrs: { file, description: 'Plan {v2} "final"' } })
    expect(await firstBlock(`::image{file="${file}" alt="a } b"}\n::`))
      .toMatchObject({ type: 'image', attrs: { file, alt: 'a } b' } })
    expect((await firstBlock('::callout{type="info" title="x } y"}\nHi.\n::'))?.attrs)
      .toMatchObject({ type: 'info' })
  })

  test('callout keeps an unquoted type instead of falling back to the default', async () => {
    expect((await firstBlock('::callout{type=warning #b-note}\nHi.\n::'))?.attrs)
      .toMatchObject({ type: 'warning', id: 'b-note' })
  })

  test('callout keeps a single-quoted type', async () => {
    expect((await firstBlock('::callout{type=\'danger\'}\nHi.\n::'))?.attrs)
      .toMatchObject({ type: 'danger' })
  })

  test('infobox keeps an unquoted title', async () => {
    expect((await firstBlock('::infobox{title=Heads-up}\nHi.\n::'))?.attrs)
      .toMatchObject({ title: 'Heads-up' })
  })

  test('image keeps an unquoted file uuid', async () => {
    expect((await firstBlock('::image{file=abc-123 alt=Logo}\n::'))?.attrs)
      .toMatchObject({ file: 'abc-123', alt: 'Logo' })
  })

  test('mention keeps an unquoted uid', async () => {
    const paragraph = await firstBlock('Ping :mention[admin]{uid=42}')
    expect(paragraph?.content?.[1]).toMatchObject({ type: 'mention', attrs: { id: 42, label: 'admin' } })
  })
})
