import { describe, expect, it } from 'vitest'
import { decodePageEntities, encodePageEntities } from './comark-entities'
import { parseMarkdownToDoc, serializeDocToMarkdown } from '../../app/comark/markdown-engine'

/** What a write of this content through the editor would store. */
const stored = (markdown: string): string =>
  serializeDocToMarkdown(parseMarkdownToDoc(markdown))

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

  it.each(bodies)('a model rewriting what it read changes nothing: %j', (body) => {
    expect(stored(encodePageEntities(decodePageEntities(body)))).toBe(stored(body))
  })

  const written = [
    'Wiki & AI, 5 < 6, 7 > 6',
    '<span>x</span>',
    '&copy; 2026 AT&T, R&D;',
    '> a blockquote with AT&T',
    'auto <https://example.com> link',
    'code `a & b <c>` here',
    '```\na & b <c>\n```',
    '| a & b | c < d |\n| --- | --- |\n| 1 | 2 |',
    '::callout{type="info"}\nAT&T <x>\n::',
    '[x](https://example.com/a?y=1&z=2)',
  ]

  it.each(written)('a model reads back the characters it wrote: %j', (text) => {
    expect(decodePageEntities(stored(encodePageEntities(text)))).toBe(text)
  })

  it('hands the model a body with no entity left in its prose', () => {
    const read = decodePageEntities(bodies.join('\n\n'))
    const prose = read.replace(/```[\s\S]*?```|`[^`\n]*`/g, '')
    expect(prose).not.toMatch(/&(amp|lt|gt|quot);/)
  })

  /** Markdown a model writes is markdown: a line opened with `>` is a quote. */
  it('reads a re-written literal marker as the syntax it spells', () => {
    expect(stored(encodePageEntities(decodePageEntities('&gt; not a quote'))))
      .toBe('> not a quote')
  })
})
