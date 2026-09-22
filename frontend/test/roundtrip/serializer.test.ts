/**
 * Direct unit tests for every custom serializer rule in the markdown
 * engine (app/comark/markdown-engine.ts + app/editor/nodes/*). Docs are
 * built programmatically against the real editor schema — no markdown
 * parsing involved, so a failure here pins the serializer rule itself
 * rather than the load path.
 */
import { describe, expect, test } from 'vitest'
import type { Node as ProseNode } from '@tiptap/pm/model'
import { serializeDocToMarkdown } from '../../app/comark/markdown-engine'
import { editorSchema as s } from './harness'

type Content = ProseNode | ProseNode[]

const doc = (...c: ProseNode[]) => s.node('doc', null, c)
const p = (c?: Content | string) => s.node('paragraph', null, typeof c === 'string' ? s.text(c) : c)
const text = (t: string, marks: string[] = []) => s.text(t, marks.map(m => s.marks[m]!.create()))

describe('serializer rules', () => {
  test('codeBlock emits the language attr', () => {
    const code = s.node('codeBlock', { language: 'ts' }, s.text('const x = 1'))
    expect(serializeDocToMarkdown(doc(code))).toBe('```ts\nconst x = 1\n```')
  })

  test('codeBlock without language emits a bare fence', () => {
    const code = s.node('codeBlock', null, s.text('plain'))
    expect(serializeDocToMarkdown(doc(code))).toBe('```\nplain\n```')
  })

  test('codeBlock grows its fence past embedded backtick runs', () => {
    const code = s.node('codeBlock', null, s.text('uses ``` inside'))
    expect(serializeDocToMarkdown(doc(code))).toBe('````\nuses ``` inside\n````')
  })

  test('callout emits the type attr and a tight close fence', () => {
    const callout = s.node('callout', { type: 'warning' }, [p('Careful.')])
    expect(serializeDocToMarkdown(doc(callout))).toBe('::callout{type="warning"}\nCareful.\n::')
  })

  test('nested fences: outer fence is one colon longer than the deepest inner', () => {
    const inner = s.node('infobox', { title: 'In' }, [p('deep')])
    const outer = s.node('callout', { type: 'info' }, [p('top'), inner])
    expect(serializeDocToMarkdown(doc(outer))).toBe(
      ':::callout{type="info"}\ntop\n\n::infobox{title="In"}\ndeep\n::\n:::',
    )
  })

  test('infobox escapes double quotes in the title', () => {
    const box = s.node('infobox', { title: 'He said "hi"' }, [p('x')])
    expect(serializeDocToMarkdown(doc(box))).toBe('::infobox{title="He said \\"hi\\""}\nx\n::')
  })

  test('infobox without title emits no attribute braces', () => {
    const box = s.node('infobox', { title: '' }, [p('x')])
    expect(serializeDocToMarkdown(doc(box))).toBe('::infobox\nx\n::')
  })

  test('mention serializes as :mention[label]{uid="…"} — uid round-trips', () => {
    const mention = s.node('mention', { id: 42, label: 'admin' })
    expect(serializeDocToMarkdown(doc(p([text('Ping '), mention])))).toBe('Ping :mention[admin]{uid="42"}')
  })

  test('mention without a uid falls back to plain @label prose', () => {
    const mention = s.node('mention', { id: null, label: 'admin' })
    expect(serializeDocToMarkdown(doc(p([text('Ping '), mention])))).toBe('Ping @admin')
  })

  test('marks: bold, italic, code, strike, underline', () => {
    const para = p([
      text('b', ['bold']), text(' '),
      text('i', ['italic']), text(' '),
      text('c', ['code']), text(' '),
      text('s', ['strike']), text(' '),
      text('u', ['underline']),
    ])
    expect(serializeDocToMarkdown(doc(para))).toBe('**b** *i* `c` ~~s~~ <u>u</u>')
  })

  test('bulletList uses "-" markers and serializes tight', () => {
    const list = s.node('bulletList', null, [
      s.node('listItem', null, [p('a')]),
      s.node('listItem', null, [p('b')]),
    ])
    expect(serializeDocToMarkdown(doc(list))).toBe('- a\n- b')
  })

  test('orderedList keeps its start attr', () => {
    const list = s.node('orderedList', { start: 3 }, [
      s.node('listItem', null, [p('three')]),
      s.node('listItem', null, [p('four')]),
    ])
    expect(serializeDocToMarkdown(doc(list))).toBe('3. three\n4. four')
  })

  test('taskList maps checked state to [x] / [ ]', () => {
    const list = s.node('taskList', null, [
      s.node('taskItem', { checked: true }, [p('done')]),
      s.node('taskItem', { checked: false }, [p('open')]),
    ])
    expect(serializeDocToMarkdown(doc(list))).toBe('- [x] done\n- [ ] open')
  })

  test('table emits a GFM pipe table with the first row as header', () => {
    const cell = (t: string) => s.node('tableCell', null, [p(t)])
    const head = (t: string) => s.node('tableHeader', null, [p(t)])
    const table = s.node('table', null, [
      s.node('tableRow', null, [head('A'), head('B')]),
      s.node('tableRow', null, [cell('1'), cell('2')]),
    ])
    expect(serializeDocToMarkdown(doc(table))).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |')
  })

  test('table cells escape pipes and collapse multi-block content to one line', () => {
    const twoBlocks = s.node('tableCell', null, [p('first'), p('second')])
    const piped = s.node('tableCell', null, [p('a | b')])
    const table = s.node('table', null, [
      s.node('tableRow', null, [s.node('tableHeader', null, [p('H1')]), s.node('tableHeader', null, [p('H2')])]),
      s.node('tableRow', null, [twoBlocks, piped]),
    ])
    expect(serializeDocToMarkdown(doc(table))).toBe(
      '| H1 | H2 |\n| --- | --- |\n| first second | a \\| b |',
    )
  })

  test('image is a block: the following block starts on its own line', () => {
    const img = s.node('image', { src: '/i.png', alt: 'alt', title: 'T' })
    expect(serializeDocToMarkdown(doc(img, p('after')))).toBe('![alt](/i.png "T")\n\nafter')
  })

  test('hardBreak serializes as a backslash break', () => {
    const para = p([text('one'), s.node('hardBreak'), text('two')])
    expect(serializeDocToMarkdown(doc(para))).toBe('one\\\ntwo')
  })
})
