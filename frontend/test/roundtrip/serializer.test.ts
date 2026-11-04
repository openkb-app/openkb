/**
 * Direct unit tests for every custom serializer rule in the markdown
 * engine (app/comark/*). Docs are built programmatically against the real
 * editor schema, so a failure here pins the serializer rule itself rather
 * than the load path. Only the `reloaded` checks parse the output back.
 */
import { describe, expect, test } from 'vitest'
import type { Node as ProseNode } from '@tiptap/pm/model'
import { parseMarkdown } from 'comark'
import { parseMarkdownToDoc, serializeDocToMarkdown } from '../../app/comark/markdown-engine'
import { parseComark } from '#shared/utils/comark-tree'
import { editorSchema as s } from './harness'

type Content = ProseNode | ProseNode[]

const doc = (...c: ProseNode[]) => s.node('doc', null, c)
const p = (c?: Content | string) => s.node('paragraph', null, typeof c === 'string' ? s.text(c) : c)
const text = (t: string, marks: string[] = []) => s.text(t, marks.map(m => s.marks[m]!.create()))

describe('serializer rules', () => {
  test('codeBlock emits the language attr', async () => {
    const code = s.node('codeBlock', { language: 'ts' }, s.text('const x = 1'))
    expect(await serializeDocToMarkdown(doc(code))).toBe('```ts\nconst x = 1\n```')
  })

  test('codeBlock without language emits a bare fence', async () => {
    const code = s.node('codeBlock', null, s.text('plain'))
    expect(await serializeDocToMarkdown(doc(code))).toBe('```\nplain\n```')
  })

  test('codeBlock holding a backtick fence line takes a tilde fence', async () => {
    const code = s.node('codeBlock', null, s.text('uses ``` inside\n```\nend'))
    const markdown = await serializeDocToMarkdown(doc(code))
    expect(markdown).toBe('~~~\nuses ``` inside\n```\nend\n~~~')
    expect((await parseMarkdownToDoc(markdown)).toJSON()).toEqual(doc(code).toJSON())
  })

  test('callout emits the type attr and a tight close fence', async () => {
    const callout = s.node('callout', { type: 'warning' }, [p('Careful.')])
    expect(await serializeDocToMarkdown(doc(callout))).toBe('::callout{type="warning"}\nCareful.\n::')
  })

  test('nested fences: the inner fence is indented and one colon longer', async () => {
    const inner = s.node('infobox', { title: 'In' }, [p('deep')])
    const outer = s.node('callout', { type: 'info' }, [p('top'), inner])
    expect(await serializeDocToMarkdown(doc(outer))).toBe(
      '::callout{type="info"}\ntop\n\n  :::infobox{title="In"}\n  deep\n  :::\n::',
    )
  })

  test('infobox single-quotes a title holding double quotes', async () => {
    const box = s.node('infobox', { title: 'He said "hi"' }, [p('x')])
    expect(await serializeDocToMarkdown(doc(box))).toBe('::infobox{title=\'He said "hi"\'}\nx\n::')
  })

  test('infobox without title emits no attribute braces', async () => {
    const box = s.node('infobox', { title: '' }, [p('x')])
    expect(await serializeDocToMarkdown(doc(box))).toBe('::infobox\nx\n::')
  })

  test('mention serializes as :mention[label]{uid="…"} — uid round-trips', async () => {
    const mention = s.node('mention', { id: 42, label: 'admin' })
    expect(await serializeDocToMarkdown(doc(p([text('Ping '), mention])))).toBe('Ping :mention[admin]{uid="42"}')
  })

  test('mention without a uid falls back to plain @label prose', async () => {
    const mention = s.node('mention', { id: null, label: 'admin' })
    expect(await serializeDocToMarkdown(doc(p([text('Ping '), mention])))).toBe('Ping @admin')
  })

  test('marks: bold, italic, code, strike, underline', async () => {
    const para = p([
      text('b', ['bold']), text(' '),
      text('i', ['italic']), text(' '),
      text('c', ['code']), text(' '),
      text('s', ['strike']), text(' '),
      text('u', ['underline']),
    ])
    expect(await serializeDocToMarkdown(doc(para))).toBe('**b** *i* `c` ~~s~~ <u>u</u>')
  })

  test('bulletList uses "-" markers and serializes tight', async () => {
    const list = s.node('bulletList', null, [
      s.node('listItem', null, [p('a')]),
      s.node('listItem', null, [p('b')]),
    ])
    expect(await serializeDocToMarkdown(doc(list))).toBe('- a\n- b')
  })

  test('orderedList keeps its start attr', async () => {
    const list = s.node('orderedList', { start: 3 }, [
      s.node('listItem', null, [p('three')]),
      s.node('listItem', null, [p('four')]),
    ])
    expect(await serializeDocToMarkdown(doc(list))).toBe('3. three\n4. four')
  })

  test('taskList maps checked state to [x] / [ ]', async () => {
    const list = s.node('taskList', null, [
      s.node('taskItem', { checked: true }, [p('done')]),
      s.node('taskItem', { checked: false }, [p('open')]),
    ])
    expect(await serializeDocToMarkdown(doc(list))).toBe('- [x] done\n- [ ] open')
  })

  test('table emits a padded GFM pipe table with the first row as header', async () => {
    const cell = (t: string) => s.node('tableCell', null, [p(t)])
    const head = (t: string) => s.node('tableHeader', null, [p(t)])
    const table = s.node('table', null, [
      s.node('tableRow', null, [head('A'), head('B')]),
      s.node('tableRow', null, [cell('1'), cell('2')]),
    ])
    expect(await serializeDocToMarkdown(doc(table))).toBe('| A   | B   |\n| --- | --- |\n| 1   | 2   |')
  })

  test('table cells escape pipes and collapse multi-block content to one line', async () => {
    const twoBlocks = s.node('tableCell', null, [p('first'), p('second')])
    const piped = s.node('tableCell', null, [p('a | b')])
    const table = s.node('table', null, [
      s.node('tableRow', null, [s.node('tableHeader', null, [p('H1')]), s.node('tableHeader', null, [p('H2')])]),
      s.node('tableRow', null, [twoBlocks, piped]),
    ])
    expect(await serializeDocToMarkdown(doc(table))).toBe(
      '| H1           | H2     |\n| ------------ | ------ |\n| first second | a \\| b |',
    )
  })

  test('image is a block: the following block starts on its own line', async () => {
    const img = s.node('image', { src: '/i.png', alt: 'alt', title: 'T' })
    expect(await serializeDocToMarkdown(doc(img, p('after')))).toBe('![alt](/i.png "T")\n\nafter')
  })

  test('the empty paragraphs a document ends on are not written', async () => {
    const code = s.node('codeBlock', null, s.text('code'))
    expect(await serializeDocToMarkdown(doc(p('intro'), code, p(), p()))).toBe('intro\n\n```\ncode\n```')
    expect(await serializeDocToMarkdown(doc(p()))).toBe('')
  })

  test('hardBreak serializes as two trailing spaces', async () => {
    const para = p([text('one'), s.node('hardBreak'), text('two')])
    expect(await serializeDocToMarkdown(doc(para))).toBe('one  \ntwo')
  })

  // The parser drops a textblock's edge whitespace, or reads a tab / four
  // leading spaces as code, so writing it would store bytes that read back
  // differently — a block change nobody typed.
  describe('a textblock at its whitespace edges reads back to the same bytes', () => {
    const withId = (node: ProseNode, id: string) => node.type.create({ ...node.attrs, id }, node.content)
    const item = (c: Content) => s.node('listItem', null, [p(c)])
    const heading = (t: string) => s.node('heading', { level: 2 }, s.text(t))
    const stable = async (d: ProseNode) => {
      const once = await serializeDocToMarkdown(d)
      expect(await serializeDocToMarkdown(await parseMarkdownToDoc(once))).toBe(once)
      return once
    }

    // Editor content as typed: every shape, mutated at its edges.
    const shapes: Record<string, (t: string) => ProseNode> = {
      'paragraph': t => p(t),
      'heading': heading,
      'bold run': t => p([text('x'), text(t, ['bold'])]),
      'after a hard break': t => p([text('a'), s.node('hardBreak'), text(t)]),
      'list item': t => s.node('bulletList', null, [item('one'), item(t)]),
      'blockquote': t => s.node('blockquote', null, [p(t)]),
    }
    const edges: Record<string, (t: string) => string> = {
      'trailing space': t => `${t} `,
      'trailing tab': t => `${t}\t`,
      'leading space': t => ` ${t}`,
      'leading tab': t => `\t${t}`,
      'four leading spaces': t => `    ${t}`,
      'both edges': t => ` \t${t}  `,
    }
    for (const [shape, make] of Object.entries(shapes)) {
      for (const [edge, mutate] of Object.entries(edges)) {
        test(`${shape}, ${edge}`, async () => {
          const once = await stable(doc(withId(p('before'), 'b-0'), withId(make(mutate('typed')), 'b-1')))
          expect(once).toContain('typed')
          expect(once).not.toContain('```')
          // A hard break is two trailing spaces; no other whitespace ends a line.
          expect(once.replace(/(?<=\S) {2}\n/g, '\n')).not.toMatch(/[ \t]{2}\{#|[ \t]\n|[ \t]$/)
        })
      }
    }

    test('a whitespace-only paragraph writes as an empty one, not a bare id', async () => {
      const once = await stable(doc(withId(p(' \t '), 'b-ws'), withId(p('next'), 'b-1')))
      expect(once).toBe(await serializeDocToMarkdown(doc(p(), withId(p('next'), 'b-1'))))
      expect(once).not.toContain('b-ws')
    })
  })

  describe('text GFM leaves alone stays text', () => {
    const link = (t: string, href: string) => s.text(t, [s.marks.link!.create({ href })])
    const reloaded = async (d: ProseNode) => {
      const once = await serializeDocToMarkdown(d)
      expect((await parseMarkdownToDoc(once)).toJSON()).toEqual(d.toJSON())
      return once
    }

    test('what GFM leaves alone is not escaped', async () => {
      expect(await reloaded(doc(p('https:// alone, www. alone, @ada and a@b')))).toBe('https:// alone, www. alone, @ada and a@b')
      expect(await reloaded(doc(p('x_@example.com')))).toBe('x\\_@example.com')
    })

    test('a link and code keep their bytes', async () => {
      expect(await reloaded(doc(p([link('https://example.com', 'https://example.com'), text(' and '), text('https://example.com', ['code'])]))))
        .toBe('<https://example.com> and `https://example.com`')
      expect(await serializeDocToMarkdown(doc(s.node('codeBlock', null, s.text('https://example.com')))))
        .toBe('```\nhttps://example.com\n```')
    })
  })

  // CommonMark reads `**` next to punctuation inside a word as literal text, so
  // such a span is written as the HTML tag comark also reads as the mark.
  describe('a mark that would not flank reads back as the same mark', () => {
    const reloaded = async (d: ProseNode) => {
      const once = await serializeDocToMarkdown(d)
      const back = await parseMarkdownToDoc(once)
      expect(back.toJSON()).toEqual(d.toJSON())
      expect(await serializeDocToMarkdown(back)).toBe(once)
      return once
    }

    test.each<[string, ProseNode[], string]>([
      ['opens at punctuation after a letter', [text('a'), text('(b)', ['bold'])], 'a<strong>(b)</strong>'],
      ['closes at punctuation before a letter', [text('foo.', ['bold']), text('bar')], '<strong>foo.</strong>bar'],
      ['opens at a symbol', [text('costs'), text('$5', ['bold'])], 'costs<strong>$5</strong>'],
      ['opens at a dot', [text('example'), text('.com', ['bold'])], 'example<strong>.com</strong>'],
      ['strike', [text('a'), text('(b)', ['strike'])], 'a<del>(b)</del>'],
      ['strike closing', [text('foo.', ['strike']), text('bar')], '<del>foo.</del>bar'],
      ['italic', [text('a'), text('(b)', ['italic'])], 'a<em>(b)</em>'],
      ['bold around code', [text('a'), text('x', ['bold', 'code']), text('b')], 'a<strong>`x`</strong>b'],
      ['an emoji inside', [text('a'), text('😀', ['bold']), text('b')], 'a<strong>😀</strong>b'],
      ['an emoji outside', [text('😀'), text('(b)', ['bold'])], '😀**(b)**'],
      ['strike after bold', [text('(b)', ['bold']), text('a', ['strike'])], '**(b)**~~a~~'],
    ])('%s', async (_name, content, written) => {
      expect(await reloaded(doc(p(content)))).toBe(written)
    })

    test('delimiters that flank stay markdown', async () => {
      expect(await reloaded(doc(p([text('a'), text('b', ['bold']), text('c')])))).toBe('a**b**c')
      expect(await reloaded(doc(p([text('a'), text('b', ['bold', 'italic']), text('c')])))).toBe('a***b***c')
      expect(await reloaded(doc(p([text('see '), text('(b)', ['bold']), text('.')])))).toBe('see **(b)**.')
      expect(await reloaded(doc(p([text('x'), text('a(b)', ['bold']), text(' y')])))).toBe('x**a(b)** y')
    })

    test.each([
      ['x <strong class="a">a</strong> b', 'x **a** b'],
      ['x <em onclick="alert(1)">a</em> b', 'x *a* b'],
      ['x <strong>a b', 'x **a b**'],
      ['x a</strong> b', 'x a b'],
      ['x <strong></strong>a b', 'x a b'],
      ['<STRONG>x</STRONG> a b', '**x** a b'],
    ])('a mark tag reads as the read page reads it: %s', async (markdown, saved) => {
      const back = await parseMarkdownToDoc(markdown)
      expect(back.textContent).toBe('x a b')
      expect(await serializeDocToMarkdown(back)).toBe(saved)
    })

    test('a paragraph opening with a mark tag stays a paragraph', async () => {
      expect(await reloaded(doc(p([text('u', ['underline']), text(' tail')])))).toBe('<u>u</u> tail')
      expect(await reloaded(doc(p('one'), p([text('(b)', ['bold']), text('c')])))).toBe('one\n\n<strong>(b)</strong>c')
    })
  })

  describe('text that looks like block syntax at a line start stays text', () => {
    const reloaded = async (d: ProseNode) => {
      const once = await serializeDocToMarkdown(d)
      expect((await parseMarkdownToDoc(once)).toJSON()).toEqual(d.toJSON())
      expect(await serializeDocToMarkdown(await parseMarkdownToDoc(once))).toBe(once)
      return once
    }

    test.each([
      ['# heading', '\\# heading'],
      ['###### six', '\\###### six'],
      ['- item', '\\- item'],
      ['+ item', '\\+ item'],
      ['-', '\\-'],
      ['2. two', '2\\. two'],
      ['10) ten', '10\\) ten'],
      ['---', '\\---'],
      ['- - -', '\\- - -'],
      ['a\n:--', 'a\n\\:--'],
      ['::callout\nx\n::', '\\::callout\nx\n\\::'],
      ['::', '\\::'],
      ['::image{file="x"}', '\\::image\\{file="x"}'],
      ['::foo', '\\::foo'],
      ['::callout foo', '\\::callout foo'],
      ['::callout[x]', '\\::callout\\[x\\]'],
      ['::callout #id', '\\::callout #id'],
      ['::callout.', '\\::callout.'],
      [':: x', '\\:: x'],
      ['::block\\', '\\::block\\\\'],
    ])('a paragraph starting %j', async (typed, written) => {
      expect(await reloaded(doc(p(typed)))).toBe(written)
    })

    test.each([
      ['a\n# h', 'a\n\\# h'],
      ['a\n- item', 'a\n\\- item'],
      ['a\n1. one', 'a\n1\\. one'],
      ['a\n1) one', 'a\n1\\) one'],
      ['a\n---', 'a\n\\---'],
      ['a\n===', 'a\n\\==='],
      ['a\n-', 'a\n\\-'],
      ['a\n::callout{type="info"}\nx\n::', 'a\n\\::callout\\{type="info"}\nx\n\\::'],
      ['a\n:::', 'a\n\\:::'],
      ['x | y\n| - - |', 'x | y\n| - - |'],
      ['see a|b\n|-', 'see a|b\n|-'],
      ['a\n::foo', 'a\n\\::foo'],
    ])('a soft-break line in %j', async (typed, written) => {
      expect(await reloaded(doc(p(typed)))).toBe(written)
    })

    test('a line after a hard break, in a list item and in a quote', async () => {
      expect(await reloaded(doc(p([text('a'), s.node('hardBreak'), text('# h')])))).toBe('a  \n\\# h')
      const item = s.node('listItem', null, [p('- x')])
      expect(await reloaded(doc(s.node('bulletList', null, [item])))).toBe('- \\- x')
      expect(await reloaded(doc(s.node('blockquote', null, [p('# h')])))).toBe('> \\# h')
      const pipeItem = s.node('listItem', null, [p('- a | b\n| - |')])
      expect(await reloaded(doc(s.node('bulletList', null, [pipeItem])))).toBe('- \\- a | b\n| - |')
    })

    test.each([
      ['a\n2. x', 'a\n2\\. x'],
      ['a\n10) x', 'a\n10\\) x'],
      ['a\n+', 'a\n\\+'],
      ['a\n1.', 'a\n1\\.'],
    ])('a soft-break line in a list item %j', async (typed, written) => {
      const item = s.node('listItem', null, [p(typed)])
      expect(await reloaded(doc(s.node('bulletList', null, [item])))).toBe(`- ${written}`)
    })

    test('a bare fence line inside a callout', async () => {
      const callout = s.node('callout', { type: 'info' }, [p('a\n::\nb')])
      expect(await reloaded(doc(callout))).toContain('a\n\\::\nb')
      const hard = s.node('callout', { type: 'info' }, [p([text('a'), s.node('hardBreak'), text('::'), s.node('hardBreak'), text('b')]), p('c')])
      expect(await reloaded(doc(hard, p('d')))).toContain('a  \n\\::  \nb\n\nc')
    })

    describe('a typed ":" before an inline component at a line start', () => {
      const components = [
        ['mention', s.node('mention', { id: 42, label: 'admin' }), ':mention[admin]{uid="42"}'],
        ['doc link', s.node('docLink', { nid: 5, label: 'Page' }), ':doc[Page]{nid="5"}'],
        ['citation', s.node('citation', { nid: 5 }), ':citation{nid="5"}'],
        ['attachment', s.node('attachmentInline', { file: 'u-1', label: 'F' }), ':attachment[F]{file="u-1"}'],
      ] as const

      test.each(components)('%s', async (_name, node, written) => {
        expect(await reloaded(doc(p([text(':'), node])))).toBe(`\\:${written}`)
        expect(await reloaded(doc(p([text('a\n:'), node])))).toBe(`a\n\\:${written}`)
        expect(await reloaded(doc(p([text('a'), s.node('hardBreak'), text(':'), node])))).toBe(`a  \n\\:${written}`)
        // A line's leading spaces are not kept: the parser drops them.
        expect(await serializeDocToMarkdown(doc(p([text('a\n  :'), node])))).toBe(`a\n\\:${written}`)
      })

      test('typed component text stays text', async () => {
        expect(await reloaded(doc(p('::mention[admin]{uid="42"}')))).toBe('\\::mention\\[admin\\]\\{uid="42"}')
        const mention = s.node('mention', { id: 42, label: 'admin' })
        expect(await reloaded(doc(p([text('::callout'), s.node('hardBreak'), text(':'), mention]))))
          .toBe('\\::callout  \n\\::mention[admin]{uid="42"}')
      })
    })

    test('what the parser reads as text is not escaped', async () => {
      for (const typed of ['#tag', 'a\n#tag', '####### seven', '1.5 litres', '1234567890. big', '-foo', 'a\n=-=', 'a|b\nc']) {
        expect(await reloaded(doc(p(typed)))).toBe(typed)
      }
      expect(await reloaded(doc(p([text('# h', ['bold'])])))).toBe('**# h**')
      expect(await reloaded(doc(p('> q')))).toBe('\\> q')
      expect(await reloaded(doc(p('a\n2. two')))).toBe('a\n2\\. two')
      expect(await reloaded(doc(p('x | y\n:--')))).toBe('x | y\n\\:--')
    })
  })

  describe('text comark reads as attributes or a component stays text', () => {
    // The read page's view: comark holds the typed text, as one paragraph.
    const read = async (markdown: string) => {
      const tree = await parseMarkdown(markdown, { autoClose: false })
      const textOf = (node: unknown): string => typeof node === 'string' ? node : (node as unknown[]).slice(2).map(textOf).join('')
      return { tags: tree.nodes.map(node => (node as unknown[])[0]), text: tree.nodes.map(textOf).join('') }
    }
    const reloaded = async (d: ProseNode, typed: string) => {
      const once = await serializeDocToMarkdown(d)
      expect((await parseMarkdownToDoc(once)).toJSON()).toEqual(d.toJSON())
      expect(await serializeDocToMarkdown(await parseMarkdownToDoc(once))).toBe(once)
      expect(await read(once)).toEqual({ tags: ['p'], text: typed })
      return once
    }

    test.each([
      ['x {a} y', 'x \\{a} y'],
      ['JSON {"a": 1}', 'JSON \\{"a": 1}'],
      ['{a} x', '\\{a} x'],
      ['x{a}', 'x\\{a}'],
      ['x {.c} y', 'x \\{.c} y'],
      ['open { brace\nto the end', 'open \\{ brace\nto the end'],
      ['::callout{type="info"}', '\\::callout\\{type="info"}'],
      [':foo here', '\\:foo here'],
      ['a :foo b', 'a \\:foo b'],
      ['a\n:foo[x] b', 'a\n\\:foo\\[x\\] b'],
      ['::foo', '\\::foo'],
      [':::foo', '\\:::foo'],
      ['::callout foo', '\\::callout foo'],
      [':foo', '\\:foo'],
    ])('%j', async (typed, written) => {
      expect(await reloaded(doc(p(typed)), typed)).toBe(written)
    })

    test('after a mark, in a heading and in a link', async () => {
      expect(await reloaded(doc(p([text('b', ['bold']), text('{x} y')])), 'b{x} y')).toBe('**b**\\{x} y')
      expect(await reloaded(doc(p([text('b', ['bold']), text(':foo')])), 'b:foo')).toBe('**b**\\:foo')
      expect(await reloaded(doc(p([text('*:foo')])), '*:foo')).toBe('\\*\\:foo')
      const heading = doc(s.node('heading', { level: 2 }, s.text('Set {a} :b')))
      expect(await serializeDocToMarkdown(heading)).toBe('## Set \\{a} \\:b')
      const link = s.text('a {b} :c', [s.marks.link!.create({ href: 'https://example.com' })])
      expect(await reloaded(doc(p([link])), 'a {b} :c')).toBe('[a \\{b} \\:c](https://example.com)')
    })

    test('what comark reads as text is not escaped', async () => {
      for (const typed of ['{{a}}', '${a}', 'a:foo', 'a: b', 'at 10:30']) {
        expect(await reloaded(doc(p(typed)), typed)).toBe(typed)
      }
      expect(await reloaded(doc(p(':)')), ':)')).toBe('\\:)')
      expect(await reloaded(doc(p(': x')), ': x')).toBe('\\: x')
      expect(await serializeDocToMarkdown(doc(p([text('{a}', ['code'])])))).toBe('`{a}`')
    })

    test('a block id closing a text block stays', async () => {
      expect(await serializeDocToMarkdown(doc(s.node('paragraph', { id: 'b-1' }, s.text('x {a}'))))).toBe('x \\{a} {#b-1}')
      const item = s.node('listItem', null, [p('item {#b-2}')])
      expect(await serializeDocToMarkdown(doc(s.node('bulletList', null, [item])))).toBe('- item \\{#b-2}')
      expect(await serializeDocToMarkdown(doc(p([text('{#b-3}'), text('x', ['bold'])])))).toBe('\\{#b-3}**x**')

      expect(await serializeDocToMarkdown(doc(p('{#b-4}')))).toBe('\\{#b-4}')
    })

    test('a {#…} the editor would not lift as the block id is escaped', async () => {
      expect(await reloaded(doc(p([text('b', ['bold']), text('{#x}')])), 'b{#x}')).toBe('**b**\\{#x}')
      expect(await reloaded(doc(p('end {#a:b}')), 'end {#a:b}')).toBe('end \\{#a:b}')
      expect(await reloaded(doc(p('end{#x}')), 'end{#x}')).toBe('end\\{#x}')
    })

    test('a {#…} typed at the end of marked text stays text', async () => {
      const link = s.marks.link!.create({ href: 'u' })
      for (const [block, markdown] of [
        [p([text('a '), text('b {#x}', ['italic'])]), 'a *b \\{#x}*'],
        [p(text('b {#x}', ['bold'])), '**b \\{#x}**'],
        [p([text('see '), s.text('a {#x}', [link])]), 'see [a \\{#x}](u)'],
        [p([text('see '), text('a {#x}', ['code'])]), 'see `a {#x}`'],
      ] as const) {
        const once = await serializeDocToMarkdown(doc(block))
        expect(once).toBe(markdown)
        expect((await parseMarkdownToDoc(once)).toJSON()).toEqual(doc(block).toJSON())
        expect(await serializeDocToMarkdown(await parseMarkdownToDoc(once))).toBe(once)
      }
    })

    test('a {#…} typed at the end of a heading stays text', async () => {
      for (const [heading, markdown] of [
        [s.node('heading', { level: 2 }, s.text('C #{#b-123}')), '## C #\\{#b-123}'],
        [s.node('heading', { level: 2, id: 'b-9' }, s.text('C #{#b-123}')), '## C #\\{#b-123} {#b-9}'],
        [s.node('heading', { level: 2, id: 'b-9' }, s.text('C {#b-123}')), '## C \\{#b-123} {#b-9}'],
      ] as const) {
        const once = await serializeDocToMarkdown(doc(heading))
        expect(once).toBe(markdown)
        expect((await parseMarkdownToDoc(once)).toJSON()).toEqual(doc(heading).toJSON())
        expect(await serializeDocToMarkdown(await parseMarkdownToDoc(once))).toBe(once)
      }
    })
  })

  describe('an inline node after any character reads back as the node', () => {
    // The read page's view: the paragraph's children, a component by its tag.
    const read = async (markdown: string) => {
      const [paragraph] = await parseComark(markdown)
      return (paragraph as unknown[]).slice(2).map(child => typeof child === 'string' ? child : (child as unknown[])[0])
    }
    const reloaded = async (d: ProseNode) => {
      const once = await serializeDocToMarkdown(d)
      expect((await parseMarkdownToDoc(once)).toJSON()).toEqual(d.toJSON())
      expect(await serializeDocToMarkdown(await parseMarkdownToDoc(once))).toBe(once)
      return { markdown: once, read: await read(once) }
    }
    const nodes = [
      ['mention', s.node('mention', { id: 42, label: 'admin' }), ':mention[admin]{uid="42"}'],
      ['doc', s.node('docLink', { nid: 5, label: 'Page' }), ':doc[Page]{nid="5"}'],
      ['citation', s.node('citation', { nid: 5 }), ':citation{nid="5"}'],
      ['attachment', s.node('attachmentInline', { file: 'u-1', label: 'F' }), ':attachment[F]{file="u-1"}'],
    ] as const

    test.each(nodes)('%s', async (tag, node, written) => {
      for (const before of ['(', 'see:', 'x', '7']) {
        expect(await reloaded(doc(p([text(before), node, text(')')]))))
          .toEqual({ markdown: `${before}${written})`, read: [before, tag, ')'] })
      }
      expect(await reloaded(doc(p([node, text(':'), node])))).toEqual({ markdown: `${written}:${written}`, read: [tag, ':', tag] })
    })

    test.each([
      ['x:mention[admin]', 'x:mention\\[admin\\]'],
      ['(:doc', '(:doc'],
      ['see::citation', 'see::citation'],
      ['7:attachment', '7:attachment'],
      ['x:image', 'x:image'],
      ['x:image{{a}}', 'x:image{{a}}'],
      ['x:image{{file="u"}}', 'x:image{{file="u"}}'],
      ['x:attachment{{a}}', 'x:attachment{{a}}'],
      ['x:citation{{nid="7"}}', 'x:citation{{nid="7"}}'],
      ['x:mention[a]{{uid="1"}}', 'x:mention\\[a\\]{{uid="1"}}'],
      ['x:doc[a]{{nid="7"}}', 'x:doc\\[a\\]{{nid="7"}}'],
    ])('typed %j stays text', async (typed, written) => {
      expect(await reloaded(doc(p(typed)))).toEqual({ markdown: written, read: [typed] })
    })

    test('hand-written ":image{{" after a space: comark reads an image naming nothing, which shows nothing', async () => {
      const written = 'a :image{{file="u"}}'
      expect(await parseComark(written)).toEqual([['p', {}, 'a ', ['image', {}], '{{file="u"}}']])
      expect((await parseMarkdownToDoc(written)).toJSON()).toEqual(doc(p('a {{file="u"}}')).toJSON())
      expect(await reloaded(doc(p('a {{file="u"}}')))).toEqual({ markdown: 'a {{file="u"}}', read: ['a {{file="u"}}'] })
    })

    test.each([
      ['mention', 'a :mention[x]{{uid="1"}}', '{{uid="1"}}'],
      ['doc', 'a :doc[x]{{nid="7"}}', '{{nid="7"}}'],
    ])('hand-written ":%s[…]{{" after a space: comark reads a node naming nothing, the editor its words', async (tag, written, rest) => {
      expect(await parseComark(written)).toEqual([['p', {}, 'a ', [tag, {}, 'x'], rest]])
      expect((await parseMarkdownToDoc(written)).textContent).toBe(`a x${rest}`)
      expect(await serializeDocToMarkdown(await parseMarkdownToDoc(written))).toBe(`a x${rest}`)
    })

    test('other typed component syntax is not escaped', async () => {
      for (const typed of ['x:foo', 'x:mentions', 'x:doc-link', 'data:image/png;base64,AAAA']) {
        expect(await reloaded(doc(p(typed)))).toEqual({ markdown: typed, read: [typed] })
      }
      const url = 'https://commons.wikimedia.org/wiki/File:Image.png'
      const link = s.marks.link!.create({ href: url })
      const { markdown } = await reloaded(doc(p(s.text(url, [link]))))
      expect(markdown).toBe(`<${url}>`)
    })
  })

  describe('heading text with a "#" that is no closing sequence keeps it', () => {
    const h = (t: string, level = 2) => s.node('heading', { level }, s.text(t))
    const reloaded = async (d: ProseNode) => {
      const once = await serializeDocToMarkdown(d)
      expect((await parseMarkdownToDoc(once)).toJSON()).toEqual(d.toJSON())
      expect(await serializeDocToMarkdown(await parseMarkdownToDoc(once))).toBe(once)
      return once
    }

    test.each([
      ['C#', '## C#'],
      ['C\\#', '## C\\\\#'],
      ['# C', '## # C'],
    ])('heading text %j', async (typed, written) => {
      expect(await reloaded(doc(h(typed)))).toBe(written)
    })

    test('a marked tail', async () => {
      const marked = s.node('heading', { level: 2 }, [text('C '), text('#', ['bold'])])
      expect(await reloaded(doc(marked))).toBe('## C **#**')
    })
  })

  describe('task item text on several lines stays one item', () => {
    const task = (checked: boolean, ...c: ProseNode[]) => s.node('taskItem', { checked }, c)
    const tasks = (...items: ProseNode[]) => s.node('taskList', null, items)
    const items = (node: unknown): number => Array.isArray(node)
      ? (node[0] === 'li' ? 1 : 0) + node.slice(2).map(items).reduce((a, b) => a + b, 0)
      : 0
    const reloaded = async (d: ProseNode) => {
      const once = await serializeDocToMarkdown(d)
      expect((await parseMarkdownToDoc(once)).toJSON()).toEqual(d.toJSON())
      expect(await serializeDocToMarkdown(await parseMarkdownToDoc(once))).toBe(once)
      return { markdown: once, items: (await parseMarkdown(once)).nodes.map(items).reduce((a, b) => a + b, 0) }
    }

    test('a soft break', async () => {
      expect(await reloaded(doc(tasks(task(false, p('a\nb')))))).toEqual({ markdown: '- [ ] a\nb', items: 1 })
    })

    test('a hard break', async () => {
      const para = p([text('a'), s.node('hardBreak'), text('b')])
      expect(await reloaded(doc(tasks(task(false, para))))).toEqual({ markdown: '- [ ] a  \nb', items: 1 })
    })

    test('a checked item followed by another', async () => {
      expect(await reloaded(doc(tasks(task(true, p('a\nb')), task(false, p('c'))))))
        .toEqual({ markdown: '- [x] a\nb\n- [ ] c', items: 2 })
    })

    test('a nested task list', async () => {
      const nested = tasks(task(false, p('c\nd')))
      expect(await reloaded(doc(tasks(task(false, p('a\nb'), nested)))))
        .toEqual({ markdown: '- [ ] a\nb\n  - [ ] c\n  d', items: 2 })
    })

    // Lazy (unindented) continuation lines: CommonMark keeps them in the item.
    test.each([
      ['flat', '- [ ] a\nb\n- [ ] c', '- [ ] a\nb\n- [ ] c'],
      ['nested', '- [ ] a\nb\n  - [x] c\n  d\n    - [ ] e\n    f', '- [ ] a\nb\n  - [x] c\n  d\n    - [ ] e\n    f'],
      ['hard break', '- [ ] a\\\nb', '- [ ] a  \nb'],
      ['then a paragraph', '- [ ] a\nb\n\nc', '- [ ] a\nb\n\nc'],
    ])('a stored lazy line, %s', async (_, stored, written) => {
      const once = await serializeDocToMarkdown(await parseMarkdownToDoc(stored))
      expect(once).toBe(written)
      expect((await parseMarkdownToDoc(once)).toJSON()).toEqual((await parseMarkdownToDoc(stored)).toJSON())
      expect(await serializeDocToMarkdown(await parseMarkdownToDoc(once))).toBe(once)
      const li = async (md: string) => (await parseMarkdown(md)).nodes.map(items).reduce((a, b) => a + b, 0)
      expect(await li(once)).toBe(await li(stored))
    })

    // A task list nested in a bullet or ordered list.
    test.each([
      ['a bullet list', '- x\n  - [ ] a\n    b', '- x\n  - [ ] a\n  b'],
      ['an ordered list', '1. x\n   - [ ] a\n     b', '1. x\n   - [ ] a\n   b'],
      ['a bullet list, lazy line', '- x\n  - [ ] a\nb', '- x\n  - [ ] a\n  b'],
    ])('a task list in %s', async (_, stored, written) => {
      const parsed = await parseMarkdownToDoc(stored)
      parsed.check()
      const once = await serializeDocToMarkdown(parsed)
      expect(once).toBe(written)
      const reloaded = await parseMarkdownToDoc(once)
      reloaded.check()
      expect(reloaded.toJSON()).toEqual(parsed.toJSON())
      expect(await serializeDocToMarkdown(reloaded)).toBe(once)
    })
  })

  describe('a hard break in a heading writes as a space, so the heading stays one block', () => {
    const br = (marks: string[] = []) => s.node('hardBreak', null, null, marks.map(m => s.marks[m]!.create()))
    const h = (c: ProseNode[]) => s.node('heading', { level: 2 }, c)
    const stable = async (d: ProseNode) => {
      const once = await serializeDocToMarkdown(d)
      const reloaded = await parseMarkdownToDoc(once)
      expect(reloaded.childCount).toBe(d.childCount)
      expect(reloaded.firstChild!.type.name).toBe('heading')
      expect(await serializeDocToMarkdown(reloaded)).toBe(once)
      return once
    }

    test.each<[string, () => ProseNode[], string]>([
      ['between words', () => [text('C'), br(), text('D')], '## C D'],
      ['at the end', () => [text('C'), br()], '## C'],
      ['at the start', () => [br(), text('C')], '## C'],
      ['two in a row', () => [text('C'), br(), br(), text('D')], '## C  D'],
      ['inside bold', () => [text('C', ['bold']), br(['bold']), text('D', ['bold'])], '## **C D**'],
    ])('%s', async (_, content, written) => {
      expect(await stable(doc(h(content())))).toBe(written)
    })

    test('a paragraph keeps its backslash break', async () => {
      expect(await stable(doc(h([text('C'), br(), text('D')]), p([text('a'), br(), text('b')]))))
        .toBe('## C D\n\na  \nb')
    })

    test('a setext heading\'s line end and the spaces around it write as one space', async () => {
      expect(await serializeDocToMarkdown(await parseMarkdownToDoc('C \n  D\n---'))).toBe('## C D')
    })
  })
})

describe('a block comment, PI, CDATA or declaration loads without its text', () => {
  test.each([
    ['<!-- c --> tail', 'tail'],
    ['<? c ?>  tail', 'tail'],
    ['- <!-- c --> two', '- two'],
    ['> <!-- open\n>\n> Body.', '> <!-- open\n>\n> Body.'],
    ['> <!doctype x\n>\n> Body.', '> <!doctype x\n>\n> Body.'],
  ])('%j saves as %j, stably', async (markdown, saved) => {
    const once = await serializeDocToMarkdown(await parseMarkdownToDoc(markdown))
    expect(once).toBe(saved)
    expect(await serializeDocToMarkdown(await parseMarkdownToDoc(once))).toBe(once)
  })

  test('the text after the end marker starts at its first character', async () => {
    expect((await parseMarkdownToDoc('<!-- c --> tail')).textContent).toBe('tail')
  })
})

describe('a list item starting with a block other than a paragraph keeps it', () => {
  test.each([
    ['a heading', '- ## a\n- b'],
    ['a heading followed by text', '- # T\n\n  text\n- next'],
    ['a component followed by text', '- ::callout{type="info"}\n  hi\n  ::\n\n  text\n- next'],
    ['a nested list of two items', '- - a\n  - b\n- next'],
  ])('%s', async (_, markdown) => {
    const loaded = await parseMarkdownToDoc(markdown)
    expect(loaded.firstChild!.childCount).toBe(2)
    expect(await serializeDocToMarkdown(loaded)).toBe(markdown)
  })

  test('a setext heading writes as ATX', async () => {
    expect(await serializeDocToMarkdown(await parseMarkdownToDoc('- a\n  ---\n- next'))).toBe('- ## a\n- next')
  })
})

describe('what the editor holds reads back from what it writes', () => {
  const mark = (name: string, attrs?: Record<string, unknown>) => s.marks[name]!.create(attrs)
  const run = (t: string, ...marks: ReturnType<typeof mark>[]) => s.text(t, marks)
  const cell = (type: 'tableHeader' | 'tableCell', ...blocks: ProseNode[]) => s.node(type, null, blocks)
  const table = (head: ProseNode[], body: ProseNode[]) =>
    s.node('table', null, [s.node('tableRow', null, head), s.node('tableRow', null, body)])

  test.each<[string, () => ProseNode, string]>([
    ['an empty paragraph between two', () => doc(p('a'), p(), p('b')), 'a\n\n\u00A0\n\nb'],
    ['two empty paragraphs between two', () => doc(p('a'), p(), p(), p('b')), 'a\n\n\u00A0\n\n\u00A0\n\nb'],
    ['an empty paragraph leading a callout', () => doc(s.node('callout', { type: 'info' }, [p(), p('b')])), '::callout{type="info"}\n\u00A0\n\nb\n::'],
    ['a relative link whose text is its href', () => doc(p(run('/foo', mark('link', { href: '/foo' })))), '[/foo](/foo)'],
    ['link text that reads as attributes', () => doc(p(run('{"a": 1}', mark('link', { href: '/u' })))), '[\\{"a": 1}](/u)'],
    ['a link with parens in its href and quotes in its title', () => doc(p(run('t', mark('link', { href: '/a)b', title: 'x "y"' })))), '[t](</a)b>){title=\'x "y"\'}'],
    ['image alt with a bracket', () => doc(s.node('image', { src: '/i.png', alt: 'a]b' })), '![a\\]b](/i.png)'],
    ['inline code holding backticks', () => doc(p(run('`code`', mark('code')))), '`` `code` ``'],
    ['inline code that is one backtick', () => doc(p(run('`', mark('code')))), '`` ` ``'],
    ['bold and underline', () => doc(p(run('a', mark('bold'), mark('underline')))), '<u>**a**</u>'],
    ['bold, then bold italic, then italic', () => doc(p([run('a', mark('bold')), run('b', mark('bold'), mark('italic')), run('c', mark('italic'))])), '**a*b***<em>c</em>'],
    ['a code fence with an info string', () => doc(s.node('codeBlock', { language: 'ts', meta: '[file.ts] {1,3}' }, s.text('x'))), '```ts [file.ts] {1,3}\nx\n```'],
  ])('%s', async (_, build, markdown) => {
    const written = build()
    expect(await serializeDocToMarkdown(written)).toBe(markdown)
    expect((await parseMarkdownToDoc(markdown)).toJSON()).toEqual(written.toJSON())
  })

  test.each<[string, () => ProseNode, string]>([
    ['a hard break a paragraph ends on', () => doc(p([run('a'), s.node('hardBreak')])), 'a'],
    ['a list in a table cell', () => doc(table([cell('tableHeader', p('h'))], [cell('tableCell', s.node('bulletList', null, [s.node('listItem', null, [p('one')]), s.node('listItem', null, [p('two')])]))])), '| h       |\n| ------- |\n| one two |'],
    ['code in a table cell', () => doc(table([cell('tableHeader', p('h'))], [cell('tableCell', s.node('codeBlock', null, s.text('x\ny')))])), '| h     |\n| ----- |\n| `x y` |'],
  ])('%s writes its nearest form, stable from the first save', async (_, build, markdown) => {
    expect(await serializeDocToMarkdown(build())).toBe(markdown)
    expect(await serializeDocToMarkdown(await parseMarkdownToDoc(markdown))).toBe(markdown)
  })

  test('a citation url with a quote reads back without the escape and writes single-quoted', async () => {
    const loaded = await parseMarkdownToDoc('see :citation{url="https://a.b/?q=\\"x\\""}')
    expect(loaded.firstChild!.lastChild!.attrs.url).toBe('https://a.b/?q="x"')
    expect(await serializeDocToMarkdown(loaded)).toBe('see :citation{url=\'https://a.b/?q="x"\'}')
  })
})

// What comark writes where its parser reads something else back: the
// accepted entries of NORMALIZATIONS.md.
// A case that starts to read back the same is a comark fix: drop its row and entry.
describe('comark gaps: what it writes reads back as something else', () => {
  const t = (x: string, marks: string[] = []) => text(x, marks)
  const li = (...blocks: ProseNode[]) => s.node('listItem', null, blocks)
  const cell = (type: 'tableHeader' | 'tableCell', ...blocks: ProseNode[]) => s.node(type, null, blocks)
  const table = (head: ProseNode, body: ProseNode) =>
    s.node('table', null, [s.node('tableRow', null, [head]), s.node('tableRow', null, [body])])
  const ol = (attrs: Record<string, unknown> | null, ...items: ProseNode[]) => s.node('orderedList', attrs, items)
  const attachment = () => s.node('attachmentInline', { file: 'u-1', label: 'F' })
  const fileImage = () => s.node('image', { file: '11111111-2222-4333-8444-555555555555', alt: 'x' })

  test.each<[string, () => ProseNode, string]>([
    ['L10', () => doc(p('see www.example.com and ada@example.com')), 'see www.example.com and ada@example.com'],
    ['L11', () => doc(p([t('bold ', ['bold']), attachment()])), '**bold**:attachment[F]{file="u-1"}'],
    ['L12', () => doc(table(cell('tableHeader', p('{a}')), cell('tableCell', p(':b')))), '| {a} |\n| --- |\n| :b  |'],
    ['L13', () => doc(p('| a | b |\n| --- | --- |')), '| a | b |\n| --- | --- |'],
    ['L14', () => doc(s.node('heading', { level: 2 }, t('C #'))), '## C #'],
    ['L15', () => doc(s.node('bulletList', null, [li(p('a'), s.node('heading', { level: 2 }, t('h')))])), '- a## h'],
    ['L16', () => doc(ol({ start: 10 }, li(p('a'), s.node('bulletList', null, [li(p('b'))])))), '10. a\n   - b'],
    ['L17', () => doc(ol({ start: 0 }, li(p('a')))), '1. a'],
    ['L18', () => doc(ol(null, li(p('c'), ol({ start: 10 }, li(p('d')))))), '1. c\n   10. d'],
    ['L19', () => doc(s.node('bulletList', null, [li(p('a'), p(), p('b'))])), '- a\n\n  b'],
    ['L20', () => doc(s.node('taskList', null, [s.node('taskItem', { checked: true }, [p()])])), '- [x]'],
    ['L20', () => doc(s.node('taskList', null, [s.node('taskItem', { checked: false }, [p()])])), '- [ ]'],
    ['L21', () => doc(s.node('callout', { type: 'info' }, [p('#tag')])), '::callout{type="info"}\n#tag\n::'],
    ['L22', () => doc(table(cell('tableHeader', p([t('a'), s.node('hardBreak'), t('b')])), cell('tableCell', p('c')))), '| a   b |\n| ----- |\n| c     |'],
    ['L23', () => doc(s.node('codeBlock', null, s.text('x = 1  \n'))), '```\nx = 1\n```'],
    ['L24', () => doc(p(' lead ')), 'lead'],
    ['L25', () => doc(s.node('taskList', null, [s.node('taskItem', { checked: false }, [p('a'), p('c')])])), '- [ ] a\n\n      c'],
    ['L26', () => doc(s.node('bulletList', null, [li(p(), s.node('codeBlock', null, s.text('a\nb'))), li(p('next'))])), '- ```\na\nb\n```\n- next'],
  ])('%s', async (_, build, written) => {
    expect(await serializeDocToMarkdown(build())).toBe(written)
    expect((await parseMarkdownToDoc(written)).toJSON()).not.toEqual(build().toJSON())
  })
})

describe('a component alone in a textblock is written inline', () => {
  const attachment = () => s.node('attachmentInline', { file: 'u-1', label: 'F' })
  const docLink = () => s.node('docLink', { nid: 27, block: null, label: 'Agents as users' })
  const li = (...blocks: ProseNode[]) => s.node('listItem', null, blocks)

  test.each<[string, () => ProseNode, string]>([
    ['an inline file in a paragraph', () => doc(p([attachment()])), ':attachment[F]{file="u-1"}'],
    ['a page link in a list item', () => doc(s.node('bulletList', null, [li(p([docLink()]))])), '- :doc[Agents as users]{nid="27"}'],
    ['a page link in a heading', () => doc(s.node('heading', { level: 2 }, [docLink()])), '## :doc[Agents as users]{nid="27"}'],
  ])('%s', async (_, build, written) => {
    expect(await serializeDocToMarkdown(build())).toBe(written)
    expect((await parseMarkdownToDoc(written)).toJSON()).toEqual(build().toJSON())
  })
})

describe('brackets comark reads as a span with no attributes', () => {
  test.each([
    ['See note [1] and a[0] here.', 'See note \\[1\\] and a\\[0\\] here.'],
    ['An [**x**] y', 'An \\[**x**\\] y'],
  ])('%s keeps its brackets and is written escaped', async (stored, written) => {
    const loaded = await parseMarkdownToDoc(stored)
    expect(await serializeDocToMarkdown(loaded)).toBe(written)
    expect((await parseMarkdownToDoc(written)).toJSON()).toEqual(loaded.toJSON())
  })

  test('a span with attributes keeps only its words', async () => {
    expect(await serializeDocToMarkdown(await parseMarkdownToDoc('Pick [a]{.x} now.'))).toBe('Pick a now.')
  })
})

describe('inline HTML inside bold or italic', () => {
  // L30: comark's parser closes the tag before its text.
  test('loses the tag, the words keep the outer mark', async () => {
    expect(await serializeDocToMarkdown(await parseMarkdownToDoc('x **<u>a</u>** y'))).toBe('x **a** y')
  })
})

describe('a tag naming no HTML element', () => {
  // L28: comark opens an element that takes the rest of its container, and the
  // editor drops it. The conversion re-spells stored bodies (`renderStoredBody`).
  test('loses its words and the rest of the container on load', async () => {
    const loaded = await parseMarkdownToDoc('The note <name> shows who.\n\nNext.')
    expect(loaded.textContent).toBe('The note')
  })

  test('written escaped, it loads as text', async () => {
    const loaded = await parseMarkdownToDoc('The note \\<name> shows who.\n\nNext.')
    expect(loaded.textContent).toBe('The note <name> shows who.Next.')
  })
})
