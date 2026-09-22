/**
 * MDC prop-brace grammar (app/editor/nodes/mdc-markdown.ts).
 *
 * comark accepts double-quoted, single-quoted and unquoted prop values;
 * the editor lane must read all three, or an authored value vanishes into
 * the node's schema default on load. The unit tests pin the parser, the
 * load tests pin the symptom the parser bug produced.
 */
import { describe, expect, test } from 'vitest'
import { parseMarkdownToJson } from '../../app/comark/markdown-engine'
import { parseMdcProps } from '../../app/editor/nodes/mdc-markdown'

describe('parseMdcProps', () => {
  test('reads double-quoted values', () => {
    expect(parseMdcProps('type="warning"')).toEqual({ type: 'warning' })
  })

  test('reads unquoted values', () => {
    expect(parseMdcProps('type=warning')).toEqual({ type: 'warning' })
  })

  test('reads single-quoted values', () => {
    expect(parseMdcProps('type=\'warning\'')).toEqual({ type: 'warning' })
  })

  test('mixes quoting styles and the #id shorthand in one brace', () => {
    expect(parseMdcProps('type=warning title="Heads up" name=\'x y\' #b-note')).toEqual({
      type: 'warning',
      title: 'Heads up',
      name: 'x y',
      id: 'b-note',
    })
  })

  test('an unquoted value ends at the next space', () => {
    expect(parseMdcProps('type=warning alt=Fine')).toEqual({ type: 'warning', alt: 'Fine' })
  })

  test('unquoted values keep punctuation comark keeps', () => {
    expect(parseMdcProps('type=warn-ing_2.5')).toEqual({ type: 'warn-ing_2.5' })
  })

  test('escaped quotes unescape to the enclosing quote character', () => {
    expect(parseMdcProps('title="He said \\"hi\\""')).toEqual({ title: 'He said "hi"' })
    expect(parseMdcProps('title=\'It\\\'s fine\'')).toEqual({ title: 'It\'s fine' })
  })

  test('a quoted value may hold what would otherwise end an unquoted one', () => {
    expect(parseMdcProps('title="a b=c" #b-1')).toEqual({ title: 'a b=c', id: 'b-1' })
  })
})

describe('unquoted props survive the load path', () => {
  const firstBlock = (markdown: string) => parseMarkdownToJson(markdown).content?.[0]

  test('callout keeps an unquoted type instead of falling back to the default', () => {
    expect(firstBlock('::callout{type=warning #b-note}\nHi.\n::')?.attrs)
      .toMatchObject({ type: 'warning', id: 'b-note' })
  })

  test('callout keeps a single-quoted type', () => {
    expect(firstBlock('::callout{type=\'danger\'}\nHi.\n::')?.attrs)
      .toMatchObject({ type: 'danger' })
  })

  test('infobox keeps an unquoted title', () => {
    expect(firstBlock('::infobox{title=Heads-up}\nHi.\n::')?.attrs)
      .toMatchObject({ title: 'Heads-up' })
  })

  test('image keeps an unquoted media uuid', () => {
    expect(firstBlock('::image{media=abc-123 alt=Logo}\n::')?.attrs)
      .toMatchObject({ media: 'abc-123', alt: 'Logo' })
  })

  test('mention keeps an unquoted uid', () => {
    const paragraph = firstBlock('Ping :mention[admin]{uid=42}')
    expect(paragraph?.content?.[1]).toMatchObject({ type: 'mention', attrs: { id: 42, label: 'admin' } })
  })
})
