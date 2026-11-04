import { describe, expect, it } from 'vitest'
import { decodePageEntities, encodePageEntities } from './comark-entities'
import { parseMarkdownToDoc, serializeDocToMarkdown } from '../../app/comark/markdown-engine'

/** What a write of this content through the editor would store. */
const stored = async (markdown: string): Promise<string> =>
  await serializeDocToMarkdown(await parseMarkdownToDoc(markdown))

describe('decodePageEntities', () => {
  it('spells the serializer\'s entities as the characters they stand for', () => {
    expect(decodePageEntities('Wiki &amp; AI, 5 &lt; 6, 7 &gt; 6'))
      .toBe('Wiki & AI, 5 < 6, 7 > 6')
    expect(decodePageEntities('&lt;span&gt;x&lt;/span&gt;')).toBe('<span>x</span>')
    expect(decodePageEntities('&quot;quoted&quot;')).toBe('"quoted"')
  })

  it('decodes one level, so a literal entity stays visible', () => {
    expect(decodePageEntities('&amp;amp; and &amp;copy;')).toBe('&amp; and &copy;')
  })

  it('leaves code spans and fenced blocks as the serializer wrote them', () => {
    expect(decodePageEntities('a `x &amp; y` b')).toBe('a `x &amp; y` b')
    expect(decodePageEntities('```\nx &lt; y\n```')).toBe('```\nx &lt; y\n```')
    expect(decodePageEntities('~~~js\nx &gt; y\n~~~')).toBe('~~~js\nx &gt; y\n~~~')
  })

  it('decodes around code rather than stopping at it', () => {
    expect(decodePageEntities('a &amp; b `c &amp; d` e &amp; f'))
      .toBe('a & b `c &amp; d` e & f')
    expect(decodePageEntities('&amp; one\n\n```\n&amp; code\n```\n\n&amp; two'))
      .toBe('& one\n\n```\n&amp; code\n```\n\n& two')
  })

  it('reads an unclosed backtick run as text', () => {
    expect(decodePageEntities('a ` b &amp; c')).toBe('a ` b & c')
  })

  it('leaves a backslash-escaped entity as written', () => {
    expect(decodePageEntities('\\&amp; \\&lt;x \\\\&amp; \\\\\\&amp;')).toBe('\\&amp; \\&lt;x \\\\& \\\\\\&amp;')
  })
})

describe('encodePageEntities', () => {
  it('encodes an ampersand that would open an entity reference', () => {
    expect(encodePageEntities('&copy; 2026, &#169;, &#x41;'))
      .toBe('&amp;copy; 2026, &amp;#169;, &amp;#x41;')
  })

  it('encodes an angle bracket that would open a tag', () => {
    expect(encodePageEntities('<span class="x">y</span>'))
      .toBe('&lt;span class="x">y&lt;/span>')
    expect(encodePageEntities('<!-- note --> <br/>')).toBe('&lt;!-- note --> &lt;br/>')
    expect(encodePageEntities('<u class="x">y</u> <strong >z</strong> <ul>')).toBe('&lt;u class="x">y</u> &lt;strong >z</strong> &lt;ul>')
  })

  it('leaves the mark tags the editor stores as tags', () => {
    expect(encodePageEntities('<u>a</u> <strong>b</strong> <em>c</em> <del>d</del>'))
      .toBe('<u>a</u> <strong>b</strong> <em>c</em> <del>d</del>')
  })

  it('leaves a backslash-escaped ampersand or angle bracket alone', () => {
    expect(encodePageEntities('\\<span> \\&copy; \\\\<b> \\\\&copy;')).toBe('\\<span> \\&copy; \\\\&lt;b> \\\\&amp;copy;')
  })

  it('leaves what the parser reads as text alone', () => {
    expect(encodePageEntities('AT&T, R&D; 5 < 6, 7 > 6')).toBe('AT&T, R&D; 5 < 6, 7 > 6')
  })

  it('leaves markdown syntax to the parser', () => {
    expect(encodePageEntities('> quoted & cited')).toBe('> quoted & cited')
    expect(encodePageEntities('see <https://example.com> and <a@b.example>'))
      .toBe('see <https://example.com> and <a@b.example>')
  })

  it('leaves code spans and fenced blocks verbatim', () => {
    expect(encodePageEntities('a `<span> & x` b')).toBe('a `<span> & x` b')
    expect(encodePageEntities('```\n<span> &copy; x\n```')).toBe('```\n<span> &copy; x\n```')
  })
})

describe('the tool boundary round trip', () => {
  const bodies = [
    'Wiki &amp; AI, 5 &lt; 6, 7 &gt; 6 {#b-1}',
    '&lt;span&gt;x&lt;/span&gt; {#b-2}',
    '&amp;copy; 2026 AT&amp;T, R&amp;D; {#b-3}',
    '> a blockquote with AT&amp;T',
    'auto <https://example.com> link {#b-4}',
    'code `a & b <c>` here {#b-5}',
    '```\na & b <c>\n```',
    '| a &amp; b | c &lt; d |\n| --- | --- |\n| 1 | 2 |',
    '::callout{type="info"}\nAT&amp;T &lt;x&gt;\n::',
    '[x](https://example.com/a?y=1&z=2) {#b-6}',
  ]

  it.each(bodies)('a model rewriting what it read changes nothing: %j', async (body) => {
    expect(await stored(encodePageEntities(decodePageEntities(body)))).toBe(await stored(body))
  })

  /** What a model writes, and how it reads that back once stored. */
  const written: [string, string][] = [
    ['Wiki & AI, 5 < 6, 7 > 6', 'Wiki & AI, 5 < 6, 7 > 6'],
    ['<span>x</span>', '\\<span>x\\</span>'],
    ['&copy; 2026 AT&T, R&D;', '\\&copy; 2026 AT&T, R\\&D;'],
    ['> a blockquote with AT&T', '> a blockquote with AT&T'],
    ['auto <https://example.com> link', 'auto <https://example.com> link'],
    ['code `a & b <c>` here', 'code `a & b <c>` here'],
    ['```\na & b <c>\n```', '```\na & b <c>\n```'],
    ['| a & b | c < d |\n| --- | --- |\n| 1 | 2 |', '| a & b | c < d |\n| ----- | ----- |\n| 1     | 2     |'],
    ['::callout{type="info"}\nAT&T <x>\n::', '::callout{type="info"}\nAT&T \\<x>\n::'],
    ['[x](https://example.com/a?y=1&z=2)', '[x](https://example.com/a?y=1&z=2)'],
  ]

  it.each(written)('a model reads back what it wrote: %j', async (text, readBack) => {
    expect(decodePageEntities(await stored(encodePageEntities(text)))).toBe(readBack)
  })

  /** Stored as the editor writes these marks: `<u>` always, the others where delimiters cannot flank. */
  it.each([
    'alpha <u>gamma</u> beta {#b-1}',
    '<u>**both**</u> marks {#b-2}',
    'a<strong>.x</strong>b a<em>.x</em>b a<del>.x</del>b {#b-3}',
  ])('a served mark tag written back stores the same bytes: %j', async (body) => {
    expect(await stored(body)).toBe(body)
    expect(await stored(encodePageEntities(decodePageEntities(body)))).toBe(body)
  })

  /** Literal text a human typed, stored backslash-escaped. */
  it.each([
    'typed \\<span>x\\</span> here {#b-1}',
    'typed \\&copy; and R\\&D; {#b-2}',
    'typed \\&amp; literally {#b-3}',
  ])('a served escape written back stores the same bytes: %j', async (body) => {
    expect(await stored(body)).toBe(body)
    expect(await stored(encodePageEntities(decodePageEntities(body)))).toBe(body)
  })

  it('hands the model a body with no entity left in its prose', () => {
    const read = decodePageEntities(bodies.join('\n\n'))
    const prose = read.replace(/```[\s\S]*?```|`[^`\n]*`/g, '')
    expect(prose).not.toMatch(/&(amp|lt|gt|quot);/)
  })

  /** Markdown a model writes is markdown: a line opened with `>` is a quote. */
  it('reads a re-written literal marker as the syntax it spells', async () => {
    expect(await stored(encodePageEntities(decodePageEntities('&gt; not a quote'))))
      .toBe('> not a quote')
  })
})
